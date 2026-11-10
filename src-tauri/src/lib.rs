use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

const TOKEN_URL: &str = "https://beam.signal4lab.com/api/extract/oauth/token";
const CRASH_SEARCH_URL: &str = "https://beam.signal4lab.com/api/extract/crash-event/v1/search";

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashSearchResponse {
    http_status: u16,
    payload: serde_json::Value,
}

#[derive(Debug)]
struct SearchInputs {
    crash_date: Option<String>,
    s4_update_date: Option<String>,
    page: Option<u32>,
}

struct InputError {
    code: Option<i64>,
    message: String,
    details: String,
}

#[tauri::command]
async fn search_crash_events(
    access_token: String,
    crash_date: Option<String>,
    s4_update_date: Option<String>,
    page: Option<u32>,
) -> Result<CrashSearchResponse, String> {
    if access_token.trim().is_empty() {
        return Ok(error_response(InputError {
            code: None,
            message: "Get an API token before searching.".into(),
            details: "Decrypt the credentials file, then request a token.".into(),
        }));
    }

    let inputs = match prepare_search(crash_date, s4_update_date, page) {
        Ok(inputs) => inputs,
        Err(response) => return Ok(response),
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|error| format!("Could not start the crash event search: {error}"))?;

    let response = client
        .get(crash_search_url(&inputs))
        .bearer_auth(access_token.trim())
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Could not reach the Beam crash event service: {error}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Ok(CrashSearchResponse {
        http_status: status.as_u16(),
        payload: interpret_body(status, body),
    })
}

fn prepare_search(
    crash_date: Option<String>,
    s4_update_date: Option<String>,
    page: Option<u32>,
) -> Result<SearchInputs, CrashSearchResponse> {
    let crash_date = blank_to_none(crash_date);
    let s4_update_date = blank_to_none(s4_update_date);
    if let Some(page) = page {
        if page == 0 {
            return Err(error_response(InputError {
                code: None,
                message: "Page starts at 1.".into(),
                details: "Use the overview summary instead of page 0.".into(),
            }));
        }
    }
    if crash_date.is_none() && s4_update_date.is_none() {
        return Err(error_response(InputError {
            code: Some(1),
            message: "Missing required parameter".into(),
            details: "Parameter of crash_date or s4_update_date was not provided.".into(),
        }));
    }
    if let Some(value) = &crash_date {
        if let Some(error) = check_crash_date(value) {
            return Err(error_response(error));
        }
    }
    if let Some(value) = &s4_update_date {
        if let Some(error) = check_update_date(value) {
            return Err(error_response(error));
        }
    }
    Ok(SearchInputs {
        crash_date,
        s4_update_date,
        page,
    })
}

fn crash_search_url(inputs: &SearchInputs) -> String {
    let mut params = Vec::new();
    if let Some(value) = &inputs.crash_date {
        params.push(format!("crash_date={value}"));
    }
    if let Some(value) = &inputs.s4_update_date {
        params.push(format!("s4_update_date={value}"));
    }
    if let Some(page) = inputs.page {
        params.push(format!("page={page}"));
    }
    if params.is_empty() {
        CRASH_SEARCH_URL.to_string()
    } else {
        format!("{CRASH_SEARCH_URL}?{}", params.join("&"))
    }
}

fn blank_to_none(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    })
}

fn error_response(error: InputError) -> CrashSearchResponse {
    let mut body = serde_json::json!({
        "message": error.message,
        "details": error.details,
    });
    if let Some(code) = error.code {
        body["code"] = serde_json::json!(code);
    }
    CrashSearchResponse {
        http_status: 0,
        payload: serde_json::json!({ "error": body }),
    }
}

fn check_crash_date(value: &str) -> Option<InputError> {
    if value.len() > 21 {
        return Some(limit_error(
            "crash_date -> parameter value exceeds 21 characters",
        ));
    }
    let parts: Vec<&str> = value.split('~').collect();
    if parts.len() > 2 || parts.iter().any(|part| !is_ymd_shape(part)) {
        return Some(format_error(
            "crash_date must be YYYY-MM-DD or YYYY-MM-DD~YYYY-MM-DD.",
        ));
    }
    for part in &parts {
        if !is_real_ymd(part) {
            return Some(date_error(&format!("crash_date -> {part} is not a real date")));
        }
    }
    if parts.len() == 2 && parts[0] > parts[1] {
        return Some(range_error("crash_date"));
    }
    None
}

fn check_update_date(value: &str) -> Option<InputError> {
    if value.len() > 39 {
        return Some(limit_error(
            "s4_update_date -> parameter value exceeds 39 characters",
        ));
    }
    let parts: Vec<&str> = value.split('~').collect();
    if parts.len() > 2 {
        return Some(format_error(
            "s4_update_date must be YYYY-MM-DDTHH:mm:ss or a start~end range.",
        ));
    }
    for part in &parts {
        if !is_timestamp_shape(part) {
            return Some(format_error(
                "s4_update_date must be YYYY-MM-DDTHH:mm:ss or a start~end range.",
            ));
        }
        if !is_real_timestamp(part) {
            return Some(date_error(&format!(
                "s4_update_date -> {part} is not a real date or time"
            )));
        }
    }
    if parts.len() == 2 && parts[0] > parts[1] {
        return Some(range_error("s4_update_date"));
    }
    None
}

fn format_error(details: &str) -> InputError {
    InputError {
        code: Some(2),
        message: "Invalid format for date range parameter".into(),
        details: details.into(),
    }
}

fn limit_error(details: &str) -> InputError {
    InputError {
        code: Some(3),
        message: "Character limit exceeded for parameter".into(),
        details: details.into(),
    }
}

fn date_error(details: &str) -> InputError {
    InputError {
        code: Some(4),
        message: "Invalid value for date in parameter".into(),
        details: details.into(),
    }
}

fn range_error(field: &str) -> InputError {
    InputError {
        code: Some(5),
        message: "Range values are inverted for date range parameter".into(),
        details: field.into(),
    }
}

fn is_ymd_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn is_timestamp_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 19
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && is_ymd_shape(&value[..10])
        && [11, 12, 14, 15, 17, 18]
            .into_iter()
            .all(|index| bytes[index].is_ascii_digit())
}

fn is_real_ymd(value: &str) -> bool {
    if !is_ymd_shape(value) {
        return false;
    }
    let year: i32 = value[0..4].parse().unwrap_or(0);
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..10].parse().unwrap_or(0);
    let max = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => return false,
    };
    (1..=max).contains(&day)
}

fn is_real_timestamp(value: &str) -> bool {
    if !is_timestamp_shape(value) {
        return false;
    }
    let hour: u32 = value[11..13].parse().unwrap_or(99);
    let minute: u32 = value[14..16].parse().unwrap_or(99);
    let second: u32 = value[17..19].parse().unwrap_or(99);
    is_real_ymd(&value[..10]) && hour <= 23 && minute <= 59 && second <= 59
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn interpret_body(status: reqwest::StatusCode, text: String) -> serde_json::Value {
    let mut payload = if text.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str::<serde_json::Value>(&text).unwrap_or_else(|_| {
            serde_json::json!({ "error": { "message": text } })
        })
    };
    if !payload.is_object() {
        payload = serde_json::json!({ "error": { "message": "The crash event service returned an unexpected response." } });
    }
    if !status.is_success() && payload.get("error").is_none() {
        let message = if status.as_u16() == 401 {
            "The access token was rejected or has expired.".to_string()
        } else {
            format!("Request failed ({status}).")
        };
        payload["error"] = serde_json::json!({ "message": message });
    }
    payload
}

#[cfg(test)]
mod tests {
    use super::{crash_search_url, hint, parse_credentials, prepare_search};

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

    #[test]
    fn builds_summary_url_without_page() {
        let inputs = prepare_search(Some("2026-01-01~2026-01-01".into()), None, None).unwrap();
        assert_eq!(
            crash_search_url(&inputs),
            "https://beam.signal4lab.com/api/extract/crash-event/v1/search?crash_date=2026-01-01~2026-01-01"
        );
    }

    #[test]
    fn builds_advanced_query_url() {
        let inputs = prepare_search(
            Some("2026-01-01~2026-01-31".into()),
            Some("2026-03-01T00:00:00~2026-03-31T23:59:59".into()),
            Some(84),
        )
        .unwrap();
        assert_eq!(
            crash_search_url(&inputs),
            "https://beam.signal4lab.com/api/extract/crash-event/v1/search?crash_date=2026-01-01~2026-01-31&s4_update_date=2026-03-01T00:00:00~2026-03-31T23:59:59&page=84"
        );
    }

    #[test]
    fn rejects_missing_date_filter() {
        let err = prepare_search(None, Some("  ".into()), Some(1)).unwrap_err();
        assert_eq!(err.payload["error"]["code"], 1);
    }

    #[test]
    fn rejects_impossible_crash_day() {
        let err = prepare_search(Some("2026-02-31".into()), None, Some(1)).unwrap_err();
        assert_eq!(err.http_status, 0);
        assert_eq!(err.payload["error"]["code"], 4);
    }

    #[test]
    fn rejects_inverted_crash_range() {
        let err = prepare_search(Some("2026-02-02~2026-02-01".into()), None, None).unwrap_err();
        assert_eq!(err.payload["error"]["code"], 5);
    }

    #[test]
    fn rejects_crash_date_over_character_limit() {
        let err = prepare_search(Some("2026-01-01~2026-01-011".into()), None, None).unwrap_err();
        assert_eq!(err.payload["error"]["code"], 3);
    }

    #[test]
    fn rejects_page_zero() {
        let err = prepare_search(Some("2026-01-01".into()), None, Some(0)).unwrap_err();
        assert!(err.payload["error"].get("code").is_none());
    }

    #[test]
    fn rejects_impossible_update_time() {
        let err = prepare_search(None, Some("2026-01-01T25:00:00".into()), None).unwrap_err();
        assert_eq!(err.payload["error"]["code"], 4);
    }

    #[test]
    fn rejects_inverted_update_range() {
        let err = prepare_search(
            None,
            Some("2026-01-02T00:00:00~2026-01-01T00:00:00".into()),
            None,
        )
        .unwrap_err();
        assert_eq!(err.payload["error"]["code"], 5);
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
        .invoke_handler(tauri::generate_handler![
            unlock_credentials,
            request_token,
            search_crash_events
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
