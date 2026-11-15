// JSON that behaves like JavaScript's JSON.parse / JSON.stringify: numbers are f64, objects keep insertion order
// (array-index keys first, like JS objects), duplicate keys keep the first position and the last value.
// `canonical` is the exact byte form every signature covers (keys in UTF-16 code unit order, safe integers only).

use std::fmt::Write as _;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Obj),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Obj(pub Vec<(String, Value)>);

impl Obj {
    pub fn new() -> Self {
        Obj(Vec::new())
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn has(&self, key: &str) -> bool {
        self.0.iter().any(|(k, _)| k == key)
    }

    /// Assign like `obj[key] = value`: replaces in place, or appends.
    pub fn set(&mut self, key: &str, value: Value) {
        if let Some(slot) = self.0.iter_mut().find(|(k, _)| k == key) {
            slot.1 = value;
        } else {
            self.0.push((key.to_string(), value));
        }
    }

    /// Builder form of `set`.
    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.set(key, value.into());
        self
    }

    /// Entries in JS property order: array-index keys ascending, then the rest in insertion order.
    pub fn ordered(&self) -> Vec<&(String, Value)> {
        let mut index: Vec<(u32, &(String, Value))> = Vec::new();
        let mut rest = Vec::new();
        for entry in &self.0 {
            match array_index(&entry.0) {
                Some(n) => index.push((n, entry)),
                None => rest.push(entry),
            }
        }
        if index.is_empty() {
            return rest;
        }
        index.sort_by_key(|(n, _)| *n);
        index.into_iter().map(|(_, e)| e).chain(rest).collect()
    }
}

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    let n: u64 = key.parse().ok()?;
    if n < 4_294_967_295 {
        Some(n as u32)
    } else {
        None
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::Str(s.to_string())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::Str(s)
    }
}
impl From<&String> for Value {
    fn from(s: &String) -> Self {
        Value::Str(s.clone())
    }
}
impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}
impl From<f64> for Value {
    fn from(n: f64) -> Self {
        Value::Num(n)
    }
}
impl From<Obj> for Value {
    fn from(o: Obj) -> Self {
        Value::Obj(o)
    }
}
impl From<Vec<Value>> for Value {
    fn from(a: Vec<Value>) -> Self {
        Value::Arr(a)
    }
}
impl<T: Into<Value>> From<Option<T>> for Value {
    fn from(o: Option<T>) -> Self {
        match o {
            Some(v) => v.into(),
            None => Value::Null,
        }
    }
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(o) => o.get(key),
            _ => None,
        }
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    pub fn num(&self, key: &str) -> Option<f64> {
        match self.get(key) {
            Some(Value::Num(n)) => Some(*n),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&Vec<Value>> {
        match self {
            Value::Arr(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_obj(&self) -> Option<&Obj> {
        match self {
            Value::Obj(o) => Some(o),
            _ => None,
        }
    }

    pub fn is_str(&self, s: &str) -> bool {
        matches!(self, Value::Str(v) if v == s)
    }
}

// ─── JS semantics helpers ────────────────────────────────────────────────────

/// `a === b` where a missing property is `undefined`. Objects and arrays are never equal (different references).
pub fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Num(x)), Some(Value::Num(y))) => x == y,
        (Some(Value::Str(x)), Some(Value::Str(y))) => x == y,
        _ => false,
    }
}

/// `value === "s"`
pub fn is(v: Option<&Value>, s: &str) -> bool {
    matches!(v, Some(Value::Str(x)) if x == s)
}

pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(Value::Str(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `a ?? b` for an optional property.
pub fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// `String(value)` (undefined → "undefined").
pub fn to_js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => display(v),
    }
}

fn display(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Num(n) => number_to_string(*n),
        Value::Str(s) => s.clone(),
        Value::Arr(a) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                x => display(x),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Obj(_) => "[object Object]".into(),
    }
}

/// `Number(value)` for comparisons such as `expiresAt <= now`.
pub fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Num(n)) => *n,
        Some(Value::Str(s)) => string_to_number(s),
        Some(Value::Arr(a)) => match a.len() {
            0 => 0.0,
            1 => string_to_number(&display(&a[0])),
            _ => f64::NAN,
        },
        Some(Value::Obj(_)) => f64::NAN,
    }
}

pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `Number("…")`
pub fn string_to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| -> f64 {
        if p.is_empty() || !p.chars().all(|c| c.is_digit(r)) {
            return f64::NAN;
        }
        p.chars().fold(0.0, |acc, c| {
            acc * f64::from(r) + f64::from(c.to_digit(r).unwrap_or(0))
        })
    };
    let lower = t.get(..2).map(str::to_ascii_lowercase);
    match lower.as_deref() {
        Some("0x") => return radix(&t[2..], 16),
        Some("0o") => return radix(&t[2..], 8),
        Some("0b") => return radix(&t[2..], 2),
        _ => {}
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body == "Infinity" {
        if t.starts_with('-') {
            return f64::NEG_INFINITY;
        }
        return f64::INFINITY;
    }
    // Rust accepts "inf"/"nan"; JS does not
    if !body
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number.prototype.toString()` — shortest round-trip digits, JS exponent rules.
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    if n.is_infinite() {
        if n < 0.0 {
            return "-Infinity".into();
        }
        return "Infinity".into();
    }
    if n < 0.0 {
        return format!("-{}", number_to_string(-n));
    }
    let sci = format!("{n:e}");
    let (mantissa, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let e: i32 = exp.parse().unwrap_or(0);
    let k = digits.len() as i32;
    let pos = e + 1;
    if k <= pos && pos <= 21 {
        let mut s = digits;
        s.extend(std::iter::repeat_n('0', (pos - k) as usize));
        return s;
    }
    if 0 < pos && pos <= 21 {
        let (a, b) = digits.split_at(pos as usize);
        return format!("{a}.{b}");
    }
    if -6 < pos && pos <= 0 {
        return format!("0.{}{}", "0".repeat((-pos) as usize), digits);
    }
    let sign = if pos - 1 < 0 { '-' } else { '+' };
    let ex = (pos - 1).abs();
    if k == 1 {
        return format!("{digits}e{sign}{ex}");
    }
    format!("{}.{}e{sign}{ex}", &digits[..1], &digits[1..])
}

pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` in UTF-16 units. A cut through a surrogate pair returns the dangling high surrogate separately.
pub fn utf16_prefix(s: &str, n: usize) -> (&str, Option<u16>) {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        let w = c.len_utf16();
        if units + w > n {
            if units < n {
                let mut buf = [0u16; 2];
                c.encode_utf16(&mut buf);
                return (&s[..i], Some(buf[0]));
            }
            return (&s[..i], None);
        }
        units += w;
    }
    (s, None)
}

/// `s.padEnd(n)`
pub fn pad_end(s: &str, n: usize) -> String {
    let len = utf16_len(s);
    let mut out = s.to_string();
    if len < n {
        out.extend(std::iter::repeat_n(' ', n - len));
    }
    out
}

// ─── parse ───────────────────────────────────────────────────────────────────

pub fn parse(text: &str) -> Result<Value, String> {
    let mut p = Parser {
        s: text.as_bytes(),
        i: 0,
        text,
    };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i < p.s.len() {
        return Err(p.unexpected());
    }
    Ok(v)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    text: &'a str,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn unexpected(&self) -> String {
        if self.i >= self.s.len() {
            return "Unexpected end of JSON input".into();
        }
        let c = self.text[self.i..].chars().next().unwrap_or('?');
        let mut shown = self.text.to_string();
        if utf16_len(&shown) > 30 {
            shown = format!("{}...", utf16_prefix(&shown, 30).0);
        }
        format!("Unexpected token '{c}', \"{shown}\" is not valid JSON")
    }

    fn value(&mut self, depth: usize) -> Result<Value, String> {
        if depth > 512 {
            return Err("JSON nesting is too deep".into());
        }
        let Some(&b) = self.s.get(self.i) else {
            return Err(self.unexpected());
        };
        match b {
            b'{' => {
                self.i += 1;
                let mut obj = Obj::new();
                self.ws();
                if self.s.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Value::Obj(obj));
                }
                loop {
                    self.ws();
                    if self.s.get(self.i) != Some(&b'"') {
                        return Err(self.unexpected());
                    }
                    let key = self.string()?;
                    self.ws();
                    if self.s.get(self.i) != Some(&b':') {
                        return Err(self.unexpected());
                    }
                    self.i += 1;
                    self.ws();
                    let v = self.value(depth + 1)?;
                    obj.set(&key, v);
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Value::Obj(obj));
                        }
                        _ => return Err(self.unexpected()),
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut arr = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Value::Arr(arr));
                }
                loop {
                    self.ws();
                    arr.push(self.value(depth + 1)?);
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Value::Arr(arr));
                        }
                        _ => return Err(self.unexpected()),
                    }
                }
            }
            b'"' => Ok(Value::Str(self.string()?)),
            b't' => self.word("true", Value::Bool(true)),
            b'f' => self.word("false", Value::Bool(false)),
            b'n' => self.word("null", Value::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(self.unexpected()),
        }
    }

    fn word(&mut self, w: &str, v: Value) -> Result<Value, String> {
        for &b in w.as_bytes() {
            if self.s.get(self.i) != Some(&b) {
                return Err(self.unexpected());
            }
            self.i += 1;
        }
        Ok(v)
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.i;
        let digits = |p: &mut Self| {
            let s = p.i;
            while p.i < p.s.len() && p.s[p.i].is_ascii_digit() {
                p.i += 1;
            }
            p.i > s
        };
        if self.s[self.i] == b'-' {
            self.i += 1;
        }
        if self.s.get(self.i) == Some(&b'0') {
            self.i += 1;
        } else if !digits(self) {
            return Err(self.unexpected());
        }
        if self.s.get(self.i) == Some(&b'.') {
            self.i += 1;
            if !digits(self) {
                return Err(self.unexpected());
            }
        }
        if matches!(self.s.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.s.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if !digits(self) {
                return Err(self.unexpected());
            }
        }
        let text = &self.text[start..self.i];
        text.parse::<f64>()
            .map(Value::Num)
            .map_err(|_| self.unexpected())
    }

    fn hex4(&mut self) -> Result<u16, String> {
        let h = self
            .s
            .get(self.i..self.i + 4)
            .ok_or_else(|| self.unexpected())?;
        let s = std::str::from_utf8(h).map_err(|_| self.unexpected())?;
        let n = u16::from_str_radix(s, 16).map_err(|_| "Bad Unicode escape in JSON".to_string())?;
        self.i += 4;
        Ok(n)
    }

    fn string(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.s.len()
                && !matches!(self.s[self.i], b'"' | b'\\')
                && self.s[self.i] >= 0x20
            {
                self.i += 1;
            }
            out.push_str(&self.text[start..self.i]);
            match self.s.get(self.i) {
                None => return Err("Unterminated string in JSON".into()),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let Some(&e) = self.s.get(self.i) else {
                        return Err(self.unexpected());
                    };
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            if (0xD800..0xDC00).contains(&hi)
                                && self.s.get(self.i..self.i + 2) == Some(b"\\u")
                            {
                                let save = self.i;
                                self.i += 2;
                                let lo = self.hex4()?;
                                if (0xDC00..0xE000).contains(&lo) {
                                    let c = 0x10000
                                        + ((u32::from(hi) - 0xD800) << 10)
                                        + (u32::from(lo) - 0xDC00);
                                    out.push(char::from_u32(c).unwrap_or('\u{FFFD}'));
                                    continue;
                                }
                                self.i = save;
                            }
                            // lone surrogates cannot live in a Rust string
                            out.push(char::from_u32(u32::from(hi)).unwrap_or('\u{FFFD}'));
                        }
                        _ => {
                            self.i -= 1;
                            return Err(self.unexpected());
                        }
                    }
                }
                Some(_) => {
                    return Err(format!(
                        "Bad control character in string literal in JSON at position {}",
                        self.text[..self.i]
                            .chars()
                            .map(char::len_utf16)
                            .sum::<usize>()
                    ));
                }
            }
        }
    }
}

// ─── stringify ───────────────────────────────────────────────────────────────

pub fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    write_string(&mut out, s);
    out
}

/// `JSON.stringify(value)`
pub fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write_compact(&mut out, v);
    out
}

fn write_number(out: &mut String, n: f64) {
    if n.is_finite() {
        out.push_str(&number_to_string(n));
    } else {
        out.push_str("null");
    }
}

fn write_compact(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(n) => write_number(out, *n),
        Value::Str(s) => write_string(out, s),
        Value::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_compact(out, x);
            }
            out.push(']');
        }
        Value::Obj(o) => {
            out.push('{');
            for (i, (k, x)) in o.ordered().into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, k);
                out.push(':');
                write_compact(out, x);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify(value, null, 2)`
pub fn stringify_pretty(v: &Value) -> String {
    let mut out = String::new();
    write_pretty(&mut out, v, 0);
    out
}

fn indent(out: &mut String, n: usize) {
    out.push('\n');
    out.extend(std::iter::repeat_n(' ', n * 2));
}

fn write_pretty(out: &mut String, v: &Value, depth: usize) {
    match v {
        Value::Arr(a) if !a.is_empty() => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                indent(out, depth + 1);
                write_pretty(out, x, depth + 1);
            }
            indent(out, depth);
            out.push(']');
        }
        Value::Obj(o) if !o.0.is_empty() => {
            out.push('{');
            for (i, (k, x)) in o.ordered().into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                indent(out, depth + 1);
                write_string(out, k);
                out.push_str(": ");
                write_pretty(out, x, depth + 1);
            }
            indent(out, depth);
            out.push('}');
        }
        other => write_compact(out, other),
    }
}

// ─── canonical ───────────────────────────────────────────────────────────────

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

pub fn canonical(v: &Value) -> Result<String, String> {
    let mut out = String::new();
    write_canonical(&mut out, v)?;
    Ok(out)
}

fn write_canonical(out: &mut String, v: &Value) -> Result<(), String> {
    match v {
        Value::Num(n) => {
            if !n.is_finite() {
                return Err("canonical: non-finite number".into());
            }
            if n.fract() != 0.0 || n.abs() > MAX_SAFE {
                return Err("canonical: only safe integers can be signed".into());
            }
            out.push_str(&number_to_string(*n));
        }
        Value::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(out, x)?;
            }
            out.push(']');
        }
        Value::Obj(o) => {
            let mut entries: Vec<&(String, Value)> = o.0.iter().collect();
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            out.push('{');
            for (i, (k, x)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, k);
                out.push(':');
                write_canonical(out, x)?;
            }
            out.push('}');
        }
        other => write_compact(out, other),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_js() {
        for (n, s) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (1.5, "1.5"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (0.1 + 0.2, "0.30000000000000004"),
            (-2.5e-10, "-2.5e-10"),
            (1_700_000_000_000.0, "1700000000000"),
            (f64::NAN, "NaN"),
        ] {
            assert_eq!(number_to_string(n), s);
        }
    }

    #[test]
    fn parse_and_stringify_match_js() {
        let v = parse(r#" {"b":1,"a":[true,null,"x\u00e9\n"],"2":"two","1":"one","b":2,"e":1.0} "#)
            .unwrap();
        assert_eq!(
            stringify(&v),
            r#"{"1":"one","2":"two","b":2,"a":[true,null,"xé\n"],"e":1}"#
        );
        assert_eq!(
            stringify(&Value::Str("\u{1}\u{7f}\u{2028}".into())),
            "\"\\u0001\u{7f}\u{2028}\""
        );
        assert_eq!(
            stringify_pretty(&parse(r#"{"a":[],"b":{},"c":[1,{"d":null}]}"#).unwrap()),
            "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    {\n      \"d\": null\n    }\n  ]\n}"
        );
        assert!(parse("{\"a\":1,}").is_err());
        assert!(parse("01").is_err());
        assert!(parse("\"\t\"").is_err());
        assert_eq!(
            parse("\"\\ud83d\\ude00\"").unwrap(),
            Value::Str("😀".into())
        );
    }

    #[test]
    fn canonical_sorts_by_utf16_and_rejects_floats() {
        let v = parse(r#"{"b":1,"a":[true,null,"x"]}"#).unwrap();
        assert_eq!(canonical(&v).unwrap(), r#"{"a":[true,null,"x"],"b":1}"#);
        assert!(canonical(&parse(r#"{"x":1.5}"#).unwrap()).is_err());
        assert!(canonical(&Value::Num(9_007_199_254_740_992.0)).is_err());
        // U+FFFD sorts after U+10000 in UTF-16 (surrogates are 0xD800..), but before it in UTF-8
        let v = Obj::new()
            .with("\u{FFFD}", 1.0)
            .with("\u{10000}", 2.0)
            .with("z", 3.0);
        assert_eq!(
            canonical(&Value::Obj(v)).unwrap(),
            "{\"z\":3,\"\u{10000}\":2,\"\u{FFFD}\":1}"
        );
    }

    #[test]
    fn strings_to_numbers_like_js() {
        assert_eq!(string_to_number(" 12 "), 12.0);
        assert_eq!(string_to_number(""), 0.0);
        assert_eq!(string_to_number("0x10"), 16.0);
        assert!(string_to_number("abc").is_nan());
        assert!(string_to_number("inf").is_nan());
        assert_eq!(string_to_number("1e3"), 1000.0);
    }

    #[test]
    fn utf16_helpers() {
        assert_eq!(utf16_len("a😀"), 3);
        assert_eq!(utf16_prefix("a😀b", 2), ("a", Some(0xD83D)));
        assert_eq!(utf16_prefix("a😀b", 3), ("a😀", None));
        assert_eq!(pad_end("é", 3), "é  ");
    }
}
