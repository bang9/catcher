// Byte encodings: base64url without padding, Crockford base32, grouped display codes.

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub fn b64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out.push(B64[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

fn b64_index(c: u8) -> Option<u32> {
    let v = match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'-' => 62,
        b'_' => 63,
        _ => return None,
    };
    Some(u32::from(v))
}

/// Same rules as the TS decoder: length % 4 == 1 is invalid, leftover bits are ignored.
pub fn unb64(text: &str) -> Result<Vec<u8>, String> {
    // TS counts UTF-16 units; any non-ASCII char fails below anyway
    if text.chars().map(char::len_utf16).sum::<usize>() % 4 == 1 {
        return Err("bad base64url".into());
    }
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in text.bytes() {
        let v = b64_index(c).ok_or("bad base64url")?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
        acc &= (1 << bits) - 1;
    }
    Ok(out)
}

pub fn b32(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 8 / 5 + 1);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for &byte in bytes {
        acc = (acc << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(CROCKFORD[((acc >> bits) & 31) as usize] as char);
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(CROCKFORD[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

pub fn unb32(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in text.chars().flat_map(char::to_uppercase) {
        let c = match c {
            c if c.is_whitespace() || c == '-' => continue,
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        };
        let v = CROCKFORD
            .iter()
            .position(|&x| x as char == c)
            .ok_or("bad base32")? as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
        acc &= (1 << bits) - 1;
    }
    Ok(out)
}

/// ABCD-EFGH-… (groups of `size` characters)
pub fn groups(text: &str, size: usize) -> String {
    text.as_bytes()
        .chunks(size)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        for n in 0..40usize {
            let bytes: Vec<u8> = (0..n as u8)
                .map(|i| i.wrapping_mul(37).wrapping_add(n as u8))
                .collect();
            assert_eq!(unb64(&b64(&bytes)).unwrap(), bytes);
            assert_eq!(&unb32(&b32(&bytes)).unwrap()[..bytes.len()], &bytes[..]);
        }
        assert!(unb64("A").is_err());
        assert!(unb64("AA=A").is_err());
        assert_eq!(b64(b"\xff\xfe"), "__4");
        assert_eq!(unb32("o1-il").unwrap(), unb32("0111").unwrap());
    }
}
