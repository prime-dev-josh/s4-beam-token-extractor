export const PAGE_RANGE_FALLBACK_MAX = 5000;

export function clampPageRange(
  from: HTMLInputElement,
  to: HTMLInputElement,
  maxPages: number | null,
) {
  const max = Math.max(1, maxPages ?? PAGE_RANGE_FALLBACK_MAX);
  from.min = "1";
  to.min = "1";
  from.max = String(max);
  to.max = String(max);
  from.step = "1";
  to.step = "1";
  let fromVal = Math.min(Math.max(1, Number(from.value) || 1), max);
  let toVal = Math.min(Math.max(1, Number(to.value) || 1), max);
  if (fromVal > toVal) toVal = fromVal;
  from.value = String(fromVal);
  to.value = String(toVal);
}

export function syncPageRangeUi(
  from: HTMLInputElement,
  to: HTMLInputElement,
  fill: HTMLElement,
  fromOut: HTMLOutputElement,
  toOut: HTMLOutputElement,
) {
  const min = Number(from.min) || 1;
  const max = Number(to.max) || PAGE_RANGE_FALLBACK_MAX;
  const fromVal = Number(from.value);
  const toVal = Number(to.value);
  fromOut.textContent = String(fromVal);
  toOut.textContent = String(toVal);
  from.setAttribute("aria-valuenow", String(fromVal));
  to.setAttribute("aria-valuenow", String(toVal));
  from.setAttribute("aria-valuemax", String(max));
  to.setAttribute("aria-valuemax", String(max));
  const span = max - min || 1;
  const left = ((fromVal - min) / span) * 100;
  const width = ((toVal - fromVal) / span) * 100;
  fill.style.left = `${left}%`;
  fill.style.width = `${Math.max(0, width)}%`;
}

export function bindPageRange(
  from: HTMLInputElement,
  to: HTMLInputElement,
  fill: HTMLElement,
  fromOut: HTMLOutputElement,
  toOut: HTMLOutputElement,
  onChange: () => void,
) {
  clampPageRange(from, to, null);
  syncPageRangeUi(from, to, fill, fromOut, toOut);

  const emit = () => {
    syncPageRangeUi(from, to, fill, fromOut, toOut);
    onChange();
  };

  from.addEventListener("input", () => {
    if (Number(from.value) > Number(to.value)) to.value = from.value;
    emit();
  });
  to.addEventListener("input", () => {
    if (Number(to.value) < Number(from.value)) from.value = to.value;
    emit();
  });
}
