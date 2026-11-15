// Option parsing that behaves like Node's util.parseArgs({strict: true, allowPositionals: true}), including its
// error messages, so usage errors read the same as in the TS CLI.

use std::collections::HashMap;

use crate::error::Error;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Str,
    Bool,
}

pub use Kind::{Bool, Str};

#[derive(Default, Debug)]
pub struct Parsed {
    strings: HashMap<String, String>,
    flags: HashMap<String, bool>,
    pub positionals: Vec<String>,
}

impl Parsed {
    pub fn str(&self, name: &str) -> Option<&str> {
        self.strings.get(name).map(String::as_str)
    }

    /// `values.x` truthy (set and non-empty)
    pub fn nonempty(&self, name: &str) -> Option<&str> {
        self.str(name).filter(|s| !s.is_empty())
    }

    pub fn flag(&self, name: &str) -> bool {
        self.flags.get(name).copied().unwrap_or(false)
    }

    pub fn positional(&self, i: usize) -> Option<&str> {
        self.positionals.get(i).map(String::as_str)
    }
}

fn unknown(raw: &str) -> Error {
    Error::usage(format!(
        "Unknown option '{raw}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{raw}\""
    ))
}

/// Byte index of the first '=' at UTF-16 position 3 or later (JS `arg.includes('=', 3)`).
fn equals_from_3(arg: &str) -> Option<usize> {
    let mut pos = 0;
    for (i, c) in arg.char_indices() {
        if c == '=' && pos >= 3 {
            return Some(i);
        }
        pos += c.len_utf16();
    }
    None
}

pub fn parse(args: &[String], spec: &[(&str, Kind)]) -> Result<Parsed, Error> {
    let kind_of = |name: &str| spec.iter().find(|(n, _)| *n == name).map(|(_, k)| *k);
    let mut out = Parsed::default();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        i += 1;
        if arg == "--" {
            out.positionals.extend(args[i..].iter().cloned());
            break;
        }
        let chars: Vec<char> = arg.chars().collect();
        let is_short = chars.len() >= 2 && chars[0] == '-' && chars[1] != '-';
        if is_short {
            // no short options are defined: a lone `-x` or the first letter of a group `-abc` is unknown
            let raw = format!("-{}", chars[1]);
            if kind_of(&chars[1].to_string()).is_none() {
                return Err(unknown(&raw));
            }
        }
        let (name, raw, value, inline) = if arg.starts_with("--") && crate::json::utf16_len(arg) > 2
        {
            match equals_from_3(arg) {
                Some(eq) => (
                    arg[2..eq].to_string(),
                    arg[..eq].to_string(),
                    Some(arg[eq + 1..].to_string()),
                    true,
                ),
                None => {
                    let name = arg[2..].to_string();
                    let mut value = None;
                    if kind_of(&name) == Some(Str) && i < args.len() {
                        value = Some(args[i].clone());
                        i += 1;
                    }
                    (name, arg.clone(), value, false)
                }
            }
        } else {
            out.positionals.push(arg.clone());
            continue;
        };
        let Some(kind) = kind_of(&name) else {
            return Err(unknown(&raw));
        };
        match (kind, value) {
            (Str, None) => {
                return Err(Error::usage(format!(
                    "Option '--{name} <value>' argument missing"
                )));
            }
            (Bool, Some(_)) => {
                return Err(Error::usage(format!(
                    "Option '--{name}' does not take an argument"
                )));
            }
            (Str, Some(v)) => {
                if !inline && v.chars().count() > 1 && v.starts_with('-') {
                    return Err(Error::usage(format!(
                        "Option '{raw}' argument is ambiguous.\nDid you forget to specify the option argument for '{raw}'?\nTo specify an option argument starting with a dash use '{raw}=-XYZ'."
                    )));
                }
                out.strings.insert(name, v);
            }
            (Bool, None) => {
                out.flags.insert(name, true);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(args: &[&str]) -> Result<Parsed, String> {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        parse(&args, &[("code", Str), ("wait", Bool), ("no-wait", Bool)])
            .map_err(|e| e.message().to_string())
    }

    #[test]
    fn matches_node_parse_args() {
        assert!(
            run(&["--foo"])
                .unwrap_err()
                .starts_with("Unknown option '--foo'. To specify")
        );
        assert!(
            run(&["-abc"])
                .unwrap_err()
                .starts_with("Unknown option '-a'.")
        );
        assert!(run(&["-5"]).unwrap_err().ends_with("as in '-- \"-5\""));
        assert_eq!(
            run(&["--code"]).unwrap_err(),
            "Option '--code <value>' argument missing"
        );
        assert_eq!(
            run(&["--code", "-x"]).unwrap_err(),
            "Option '--code' argument is ambiguous.\nDid you forget to specify the option argument for '--code'?\nTo specify an option argument starting with a dash use '--code=-XYZ'."
        );
        assert_eq!(run(&["--code", "-"]).unwrap().str("code"), Some("-"));
        assert_eq!(
            run(&["--wait=1"]).unwrap_err(),
            "Option '--wait' does not take an argument"
        );
        let p = run(&["--code=-x", "p"]).unwrap();
        assert_eq!(
            (p.str("code"), p.positionals.clone()),
            (Some("-x"), vec!["p".to_string()])
        );
        assert_eq!(run(&["--", "--foo"]).unwrap().positionals, vec!["--foo"]);
        assert!(run(&["--no-wait"]).unwrap().flag("no-wait"));
        assert_eq!(run(&["-"]).unwrap().positionals, vec!["-"]);
        assert!(
            run(&["--=x"])
                .unwrap_err()
                .starts_with("Unknown option '--=x'.")
        );
        assert!(
            run(&["---x"])
                .unwrap_err()
                .starts_with("Unknown option '---x'.")
        );
        assert_eq!(
            run(&["--code", "a", "--code", "b"]).unwrap().str("code"),
            Some("b")
        );
    }
}
