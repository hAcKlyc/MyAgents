//! Windows CLI child launch. The app is a GUI executable, so a console child
//! can otherwise allocate a visible console when invoked from a hidden runtime.
//! Keep the CLI's inherited streams and hide only a newly created console.

use std::env;
use std::ffi::{OsStr, OsString};
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    DuplicateHandle, DUPLICATE_SAME_ACCESS, HANDLE, INVALID_HANDLE_VALUE, WAIT_FAILED,
};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetCurrentProcess, GetExitCodeProcess, WaitForSingleObject,
    CREATE_UNICODE_ENVIRONMENT, INFINITE, PROCESS_INFORMATION, STARTF_USESHOWWINDOW,
    STARTF_USESTDHANDLES, STARTUPINFOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

pub(super) fn run(
    node: &Path,
    script: &Path,
    args: &[String],
    global_port: Option<&str>,
) -> io::Result<i32> {
    let application = nul_terminated(node.as_os_str())?;
    let mut command_line = command_line(node, script, args)?;
    let mut environment = environment_block(global_port)?;

    // STARTF_USESTDHANDLES requires inheritable handles. Duplicate the current
    // streams instead of changing their inheritance flags on the app process.
    let stdin = duplicate_std_handle(STD_INPUT_HANDLE)?;
    let stdout = duplicate_std_handle(STD_OUTPUT_HANDLE)?;
    let stderr = duplicate_std_handle(STD_ERROR_HANDLE)?;
    let mut startup: STARTUPINFOW = unsafe { zeroed() };
    startup.cb = size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    startup.wShowWindow = SW_HIDE as u16;
    startup.hStdInput = raw_handle(&stdin);
    startup.hStdOutput = raw_handle(&stdout);
    startup.hStdError = raw_handle(&stderr);

    let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_UNICODE_ENVIRONMENT,
            environment.as_mut_ptr().cast(),
            null(),
            &startup,
            &mut process_info,
        )
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    let process = unsafe { OwnedHandle::from_raw_handle(process_info.hProcess) };
    let _thread = unsafe { OwnedHandle::from_raw_handle(process_info.hThread) };
    drop((stdin, stdout, stderr));

    if unsafe { WaitForSingleObject(process.as_raw_handle(), INFINITE) } == WAIT_FAILED {
        return Err(io::Error::last_os_error());
    }
    let mut exit_code = 0;
    if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut exit_code) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(exit_code as i32)
}

fn duplicate_std_handle(kind: u32) -> io::Result<Option<OwnedHandle>> {
    let source = unsafe { GetStdHandle(kind) };
    if source.is_null() || source == INVALID_HANDLE_VALUE {
        return Ok(None);
    }
    let mut duplicate = null_mut();
    let current = unsafe { GetCurrentProcess() };
    if unsafe {
        DuplicateHandle(
            current,
            source,
            current,
            &mut duplicate,
            0,
            1,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(Some(unsafe { OwnedHandle::from_raw_handle(duplicate) }))
}

fn raw_handle(handle: &Option<OwnedHandle>) -> HANDLE {
    handle
        .as_ref()
        .map_or(null_mut(), AsRawHandle::as_raw_handle)
}

fn nul_terminated(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut wide: Vec<u16> = value.encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "embedded NUL"));
    }
    wide.push(0);
    Ok(wide)
}

fn command_line(node: &Path, script: &Path, args: &[String]) -> io::Result<Vec<u16>> {
    let mut result = Vec::new();
    for arg in std::iter::once(node.as_os_str())
        .chain(std::iter::once(script.as_os_str()))
        .chain(args.iter().map(OsStr::new))
    {
        if !result.is_empty() {
            result.push(b' ' as u16);
        }
        let wide: Vec<u16> = arg.encode_wide().collect();
        if wide.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "embedded NUL in CLI argument",
            ));
        }
        quote_windows_arg(&wide, &mut result);
    }
    result.push(0);
    Ok(result)
}

// The Windows C runtime argv rules used by Node: double backslashes before a
// quote and before the closing quote; preserve all other backslashes.
fn quote_windows_arg(arg: &[u16], out: &mut Vec<u16>) {
    out.push(b'"' as u16);
    let mut slashes = 0;
    for &unit in arg {
        if unit == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        if unit == b'"' as u16 {
            out.extend(std::iter::repeat(b'\\' as u16).take(slashes * 2 + 1));
        } else {
            out.extend(std::iter::repeat(b'\\' as u16).take(slashes));
        }
        out.push(unit);
        slashes = 0;
    }
    out.extend(std::iter::repeat(b'\\' as u16).take(slashes * 2));
    out.push(b'"' as u16);
}

fn environment_block(global_port: Option<&str>) -> io::Result<Vec<u16>> {
    let mut variables: Vec<(OsString, OsString)> = env::vars_os()
        .filter(|(key, _)| {
            let key = key.to_string_lossy();
            !key.eq_ignore_ascii_case("NO_PROXY")
                && (global_port.is_none() || !key.eq_ignore_ascii_case("MYAGENTS_PORT"))
        })
        .collect();
    if let Some(port) = global_port {
        variables.push(("MYAGENTS_PORT".into(), port.into()));
    }
    variables.push((
        "no_proxy".into(),
        crate::proxy_config::LOCALHOST_NO_PROXY.into(),
    ));
    variables.sort_by_key(|(key, _)| key.to_string_lossy().to_lowercase());

    let mut block = Vec::new();
    for (key, value) in variables {
        let key: Vec<u16> = key.encode_wide().collect();
        let value: Vec<u16> = value.encode_wide().collect();
        if key.contains(&0) || value.contains(&0) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "embedded NUL in environment",
            ));
        }
        block.extend(key);
        block.push(b'=' as u16);
        block.extend(value);
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_preserves_spaces_quotes_and_trailing_backslashes() {
        let line = command_line(
            Path::new(r"C:\Program Files\node.exe"),
            Path::new(r"C:\My Agents\cli.cjs"),
            &[
                String::new(),
                "hello world".into(),
                "a\"b".into(),
                "end\\".into(),
            ],
        )
        .unwrap();
        let result = String::from_utf16(&line[..line.len() - 1]).unwrap();
        assert_eq!(
            result,
            r#""C:\Program Files\node.exe" "C:\My Agents\cli.cjs" "" "hello world" "a\"b" "end\\""#
        );
    }
}
