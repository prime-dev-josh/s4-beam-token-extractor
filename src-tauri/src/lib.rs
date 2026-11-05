use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

const TOKEN_URL: &str = "https://beam.signal4lab.com/api/extract/oauth/token";

struct Credentials {
    client_id: String,
    client_secret: String,
}

struct AppState {
    credentials: Mutex<Option<Credentials>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialSummary {
    file_name: String,
    client_id_hint: String,
    expires_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenInfo {
    access_token: String,
    token_type: String,
    expires_in: u64,
}

#[derive(serde::Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
}

#[derive(serde::Deserialize)]
struct ErrorBody {
    message: Option<String>,
}

#[tauri::command]
async fn unlock_credentials(
    path: String,
    passphrase: String,
    state: State<'_, AppState>,
) -> Result<CredentialSummary, String> {
    let path = PathBuf::from(&path);
    if !path.is_file() {
        return Err("Choose an encrypted credentials file first.".into());
    }
    if passphrase.trim().is_empty() {
        return Err("Enter the passphrase for your private key.".into());
    }

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("credentials")
        .to_string();
    let plaintext = tauri::async_runtime::spawn_blocking(move || decrypt_asc(&path, &passphrase))
        .await
        .map_err(|_| "Decryption was interrupted.".to_string())??;
    let parsed = parse_credentials(&plaintext)?;
    let summary = CredentialSummary {
        file_name: file_name.clone(),
        client_id_hint: hint(&parsed.client_id),
        expires_at: parsed.expires_at.clone(),
    };

    let mut guard = state
        .credentials
        .lock()
        .map_err(|_| "Could not store the unlocked credentials.".to_string())?;
    *guard = Some(Credentials {
        client_id: parsed.client_id,
        client_secret: parsed.client_secret,
    });

    Ok(summary)
}

#[tauri::command]
async fn request_token(state: State<'_, AppState>) -> Result<TokenInfo, String> {
    let creds = {
        let guard = state
            .credentials
            .lock()
            .map_err(|_| "Could not read the unlocked credentials.".to_string())?;
        guard
            .as_ref()
            .map(|creds| (creds.client_id.clone(), creds.client_secret.clone()))
            .ok_or_else(|| "Decrypt a credentials file before requesting a token.".to_string())?
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Could not start the token request: {error}"))?;

    let response = client
        .post(TOKEN_URL)
        .basic_auth(creds.0, Some(creds.1))
        .header("Accept", "application/json")
        .form(&[("grant_type", "client_credentials")])
        .send()
        .await
        .map_err(|error| format!("Could not reach the Beam token service: {error}"))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<ErrorBody>(&body)
            .ok()
            .and_then(|error| error.message)
            .filter(|message| !message.is_empty());
        return Err(match status.as_u16() {
            401 => "Signal4 rejected these credentials. Check that this is the latest file from Signal4.".into(),
            _ => message.unwrap_or_else(|| format!("Token request failed ({status}).")),
        });
    }

    let token: TokenResponse = response
        .json()
        .await
        .map_err(|_| "The token service returned an unexpected response.".to_string())?;

    if token.access_token.is_empty() {
        return Err("The token service did not return an access token.".into());
    }

    Ok(TokenInfo {
        access_token: token.access_token,
        token_type: token.token_type,
        expires_in: token.expires_in,
    })
}

fn decrypt_asc(path: &Path, passphrase: &str) -> Result<String, String> {
    let gpg = find_gpg()?;
    let mut child = Command::new(&gpg)
        .args([
            "--batch",
            "--yes",
            "--decrypt",
            "--pinentry-mode",
            "loopback",
            "--passphrase-fd",
            "0",
        ])
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start GnuPG: {error}"))?;

    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Could not send the passphrase to GnuPG.".to_string())?;
        writeln!(stdin, "{passphrase}")
            .map_err(|error| format!("Could not send the passphrase to GnuPG: {error}"))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|error| format!("GnuPG did not finish: {error}"))?;
    if !output.status.success() {
        return Err(friendly_gpg_error(&output.stderr));
    }

    String::from_utf8(output.stdout)
        .map_err(|_| "The decrypted file is not text.".to_string())
}

fn find_gpg() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in ["gpg.exe", "gpg"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }

    let mut extras = Vec::new();
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        extras.push(
            PathBuf::from(program_files)
                .join("GnuPG")
                .join("bin")
                .join("gpg.exe"),
        );
    }
    if let Ok(program_files) = std::env::var("ProgramFiles(x86)") {
        extras.push(
            PathBuf::from(program_files)
                .join("GnuPG")
                .join("bin")
                .join("gpg.exe"),
        );
    }
    extras.push(PathBuf::from(r"C:\Program Files\GnuPG\bin\gpg.exe"));

    for candidate in extras {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err("GnuPG is not installed. Install Gpg4win, then open this app again.".into())
}

fn friendly_gpg_error(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr).to_lowercase();
    if text.contains("bad session key") || text.contains("bad passphrase") {
        return "That passphrase was not accepted.".into();
    }
    if text.contains("no secret key") {
        return "No matching private key is on this computer. This file must be decrypted with the key you sent to Signal4.".into();
    }
    if text.contains("no valid opengpg data") || text.contains("no valid openpgp data") {
        return "That file is not an encrypted OpenPGP message.".into();
    }
    "GnuPG could not decrypt that file. Check the file and passphrase, then try again.".into()
}

struct ParsedCredentials {
    client_id: String,
    client_secret: String,
    expires_at: String,
}

fn parse_credentials(text: &str) -> Result<ParsedCredentials, String> {
    let mut client_id = None;
    let mut client_secret = None;
    let mut expires_at = None;

    for raw in text.lines() {
        let line = raw.trim().trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = split_pair(line) else {
            continue;
        };
        let value = value.trim().to_string();
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "client_id" => client_id = Some(value),
            "client_secret" => client_secret = Some(value),
            "expires_at" => expires_at = Some(value),
            _ => {}
        }
    }

    Ok(ParsedCredentials {
        client_id: client_id.ok_or("The decrypted file is missing client_id.")?,
        client_secret: client_secret.ok_or("The decrypted file is missing client_secret.")?,
        expires_at: expires_at.unwrap_or_else(|| "Not listed".into()),
    })
}

fn split_pair(line: &str) -> Option<(&str, &str)> {
    if let Some((key, value)) = line.split_once('=') {
        return Some((key, value));
    }
    line.split_once(':')
}

fn hint(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 8 {
        return "••••••••".into();
    }
    let start: String = chars.iter().take(4).collect();
    let end: String = chars.iter().skip(chars.len() - 4).collect();
    format!("{start}…{end}")
}

#[cfg(test)]
mod tests {
    use super::{hint, parse_credentials};

    #[test]
    fn parses_signal4_plaintext() {
        let parsed = parse_credentials(
            "client_id=abcdEFGHijklmnop123456..\nclient_secret=wxyzABCDEfghijkl789012..\nexpires_at=2027-01-01T00:00:00\n",
        )
        .unwrap();
        assert_eq!(parsed.client_id, "abcdEFGHijklmnop123456..");
        assert_eq!(parsed.client_secret, "wxyzABCDEfghijkl789012..");
        assert_eq!(parsed.expires_at, "2027-01-01T00:00:00");
    }

    #[test]
    fn masks_client_id() {
        assert_eq!(hint("abcdEFGHijklmnop123456.."), "abcd…56..");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            credentials: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![unlock_credentials, request_token])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
