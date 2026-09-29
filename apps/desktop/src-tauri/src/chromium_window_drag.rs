use std::sync::OnceLock;

use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};

static PATCH_INSTALLED: OnceLock<()> = OnceLock::new();

unsafe extern "C-unwind" fn disable_native_window_drag(_view: *mut AnyObject, _cmd: Sel) -> Bool {
    Bool::NO
}

pub(crate) fn install() -> Result<(), &'static str> {
    if PATCH_INSTALLED.get().is_some() {
        return Ok(());
    }

    // WKWebView returns NO here. Chromium returns YES, letting AppKit move the
    // overlay window before Tauri's drag.js can exclude interactive tabs.
    // Retry on a later load if CEF has not registered the class yet.
    let class = AnyClass::get(c"RenderWidgetHostViewCocoa")
        .ok_or("Chromium render view class was not registered")?;
    let selector = objc2::sel!(mouseDownCanMoveWindow);
    let method = class
        .instance_method(selector)
        .ok_or("Chromium render view has no mouseDownCanMoveWindow method")?;
    let encoding = unsafe { objc2::ffi::method_getTypeEncoding(method) };
    if encoding.is_null() {
        return Err("Chromium render view method has no type encoding");
    }
    let implementation: Imp = unsafe {
        std::mem::transmute::<unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> Bool, Imp>(
            disable_native_window_drag,
        )
    };

    // SAFETY: The class is registered and its existing method supplies the
    // Objective-C type encoding. The replacement has the same receiver,
    // selector, and BOOL return ABI and remains valid for the process lifetime.
    unsafe {
        objc2::ffi::class_replaceMethod(
            class as *const AnyClass as *mut AnyClass,
            selector,
            implementation,
            encoding,
        );
    }
    PATCH_INSTALLED.get_or_init(|| ());
    Ok(())
}
