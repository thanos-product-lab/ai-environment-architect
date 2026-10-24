// The delimiter escape (IMPL §1.6). Items are framed by `<<<ITEM …>>>` and `<<<END …>>>`, so
// rendered repository text must never contain `<<<` or `>>>`.
//
// Text is read left to right, counting the equal angle brackets in a row since the last inserted
// backslash. When the count is at least two and the next character is that bracket or a backslash,
// a backslash is inserted before it and the count starts again from that character: one for a
// bracket, zero for a backslash. The output never has three equal angle brackets in a row, and a
// backslash after two counted brackets is always one that was inserted, so one pass reverses it.

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
