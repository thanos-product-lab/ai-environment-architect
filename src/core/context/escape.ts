// The delimiter escape (IMPL §1.6). Items are framed by `<<<ITEM …>>>` and `<<<END …>>>`, so
// rendered repository text must never contain `<<<` or `>>>`.
//
// After two equal angle brackets in a row, a backslash is inserted before a third one or before a
// backslash. The output never has three equal angle brackets in a row, and a backslash after two
// equal angle brackets is always one that was inserted, so the escape can be reversed exactly.

const BACKSLASH = "\\";

function isAngle(char: string): boolean {
  return char === "<" || char === ">";
}

export function escapeDelimiters(text: string): string {
  let out = "";
  let run = "";
  let count = 0;
  for (const char of text) {
    if (count >= 2 && (char === run || char === BACKSLASH)) {
      out += BACKSLASH;
      count = 0;
    }
    out += char;
    if (isAngle(char) && char === run && count > 0) count++;
    else if (isAngle(char)) {
      run = char;
      count = 1;
    } else count = 0;
  }
  return out;
}

export function unescapeDelimiters(text: string): string {
  let out = "";
  let run = "";
  let count = 0;
  for (const char of text) {
    if (count >= 2 && char === BACKSLASH) {
      count = 0;
      continue;
    }
    out += char;
    if (isAngle(char) && char === run && count > 0) count++;
    else if (isAngle(char)) {
      run = char;
      count = 1;
    } else count = 0;
  }
  return out;
}
