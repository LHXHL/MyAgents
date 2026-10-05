//! OS sleep boundaries invalidate the device connection synchronously. This is
//! a lifecycle notification, not a lease clock and never cancels accepted work.
#[cfg(target_os = "macos")]
mod platform {
    use super::super::actor::ManagedAgentNetwork;
    use super::super::NetworkError;
    use objc2::ffi::{objc_setAssociatedObject, OBJC_ASSOCIATION_RETAIN_NONATOMIC};
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadOnly};
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceWillSleepNotification,
    };
    use objc2_foundation::{MainThreadMarker, NSNotification, NSObject, NSObjectProtocol};
    use std::sync::Weak;
    static OBSERVER_KEY: u8 = 0;
    struct Ivars {
        app: tauri::AppHandle,
        owner: Weak<super::super::actor::AgentNetwork>,
    }
    define_class!(
        // SAFETY: NSObject has no subclassing requirements; the workspace
        // observer is installed and invoked by AppKit on its main thread.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "MyAgentsNetworkPowerObserver"]
        #[ivars = Ivars]
        struct Observer;
        unsafe impl NSObjectProtocol for Observer {}
        impl Observer {
            #[unsafe(method(networkWillSleep:))]
            fn will_sleep(&self, _notification: &NSNotification) {
                if let Some(owner) = self.ivars().owner.upgrade() { owner.power_boundary(&self.ivars().app, true); }
            }
            #[unsafe(method(networkDidWake:))]
            fn did_wake(&self, _notification: &NSNotification) {
                if let Some(owner) = self.ivars().owner.upgrade() { owner.power_boundary(&self.ivars().app, false); }
            }
        }
    );
    impl Observer {
        fn new(
            mtm: MainThreadMarker,
            app: tauri::AppHandle,
            owner: ManagedAgentNetwork,
        ) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars {
                app,
                owner: std::sync::Arc::downgrade(&owner),
            });
            // SAFETY: NSObject's init signature matches the superclass.
            unsafe { msg_send![super(this), init] }
        }
    }
    pub(crate) struct Monitor {
        app: tauri::AppHandle,
    }
    pub(crate) fn install(
        app: tauri::AppHandle,
        owner: ManagedAgentNetwork,
    ) -> Result<Monitor, NetworkError> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| NetworkError::new("NETWORK_POWER_MONITOR_UNAVAILABLE"))?;
        let workspace = NSWorkspace::sharedWorkspace();
        let observer = Observer::new(mtm, app.clone(), owner);
        let center = workspace.notificationCenter();
        // SAFETY: immutable AppKit constants and exact selector signatures.
        unsafe {
            center.addObserver_selector_name_object(
                &observer,
                sel!(networkWillSleep:),
                Some(NSWorkspaceWillSleepNotification),
                None,
            );
            center.addObserver_selector_name_object(
                &observer,
                sel!(networkDidWake:),
                Some(NSWorkspaceDidWakeNotification),
                None,
            );
            objc_setAssociatedObject(
                (&*workspace as *const NSWorkspace)
                    .cast_mut()
                    .cast::<AnyObject>(),
                (&OBSERVER_KEY as *const u8).cast(),
                (&*observer as *const Observer).cast_mut().cast(),
                OBJC_ASSOCIATION_RETAIN_NONATOMIC,
            );
        }
        Ok(Monitor { app })
    }
    impl Drop for Monitor {
        fn drop(&mut self) {
            let _ = self.app.run_on_main_thread(|| {
                let workspace = NSWorkspace::sharedWorkspace();
                // SAFETY: same association key, releasing only our App observer.
                unsafe {
                    objc_setAssociatedObject(
                        (&*workspace as *const NSWorkspace)
                            .cast_mut()
                            .cast::<AnyObject>(),
                        (&OBSERVER_KEY as *const u8).cast(),
                        std::ptr::null_mut(),
                        OBJC_ASSOCIATION_RETAIN_NONATOMIC,
                    );
                }
            });
        }
    }
}
#[cfg(target_os = "windows")]
mod platform {
    use super::super::{actor::ManagedAgentNetwork, NetworkError};
    use windows_sys::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, PowerUnregisterSuspendResumeNotification,
        DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, HPOWERNOTIFY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMECRITICAL,
        PBT_APMRESUMESUSPEND, PBT_APMSUSPEND,
    };
    struct Context {
        app: tauri::AppHandle,
        owner: ManagedAgentNetwork,
    }
    pub(crate) struct Monitor {
        handle: HPOWERNOTIFY,
        context: Box<Context>,
    }
    // SAFETY: registration handles are unregistered from any thread; boxed
    // callback context has a stable address and only holds thread-safe owners.
    unsafe impl Send for Monitor {}
    unsafe extern "system" fn callback(
        context: *const core::ffi::c_void,
        event: u32,
        _setting: *const core::ffi::c_void,
    ) -> u32 {
        // SAFETY: the pointer stays owned until synchronous unregistration.
        let context = unsafe { &*context.cast::<Context>() };
        match event {
            PBT_APMSUSPEND => context.owner.power_boundary(&context.app, true),
            PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND | PBT_APMRESUMECRITICAL => {
                context.owner.power_boundary(&context.app, false)
            }
            _ => {}
        }
        0
    }
    pub(crate) fn install(
        app: tauri::AppHandle,
        owner: ManagedAgentNetwork,
    ) -> Result<Monitor, NetworkError> {
        let context = Box::new(Context { app, owner });
        let parameters = DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(callback),
            Context: (&*context as *const Context).cast_mut().cast(),
        };
        let mut handle = std::ptr::null_mut();
        // SAFETY: callback flag interprets recipient as this exact parameter
        // struct; API reads parameters during registration, context stays live.
        let status = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                (&parameters as *const DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS)
                    .cast_mut()
                    .cast(),
                &mut handle,
            )
        };
        if status != 0 {
            return Err(NetworkError::new("NETWORK_POWER_MONITOR_UNAVAILABLE"));
        }
        // Registration writes a pointer, while unregistration takes the same
        // pointer-sized handle as HPOWERNOTIFY in windows-sys.
        Ok(Monitor {
            handle: handle as HPOWERNOTIFY,
            context,
        })
    }
    impl Drop for Monitor {
        fn drop(&mut self) {
            // SAFETY: unique successful registration, context still alive.
            let status = unsafe { PowerUnregisterSuspendResumeNotification(self.handle) };
            if status != 0 {
                // OS could still retain the callback. Keep this single bounded
                // registration context alive through process exit rather than
                // freeing a pointer the OS can invoke.
                let replacement = Box::new(Context {
                    app: self.context.app.clone(),
                    owner: self.context.owner.clone(),
                });
                let live = std::mem::replace(&mut self.context, replacement);
                let _ = Box::leak(live);
            }
        }
    }
}
#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(crate) use platform::{install, Monitor};

#[cfg(target_os = "linux")]
pub(crate) async fn install_linux() -> Result<(Monitor, bool), super::NetworkError> {
    use super::NetworkError;
    let establish = async {
        let connection = zbus::Connection::system()
            .await
            .map_err(|_| NetworkError::new("NETWORK_POWER_MONITOR_UNAVAILABLE"))?;
        let proxy = zbus::Proxy::new_owned(
            connection,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        )
        .await
        .map_err(|_| NetworkError::new("NETWORK_POWER_MONITOR_UNAVAILABLE"))?;
        // Subscribe before reading state, so startup during suspend cannot miss
        // the matching resume signal or create a connection while sleeping.
        let signals = proxy
            .receive_signal("PrepareForSleep")
            .await
            .map_err(|_| NetworkError::new("NETWORK_POWER_MONITOR_UNAVAILABLE"))?;
        let sleeping: bool = proxy
            .get_property("PreparingForSleep")
            .await
            .map_err(|_| NetworkError::new("NETWORK_POWER_MONITOR_UNAVAILABLE"))?;
        Ok((Monitor { signals }, sleeping))
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), establish)
        .await
        .map_err(|_| NetworkError::new("NETWORK_POWER_MONITOR_UNAVAILABLE"))?
}

#[cfg(target_os = "linux")]
pub(crate) struct Monitor {
    signals: zbus::proxy::SignalStream<'static>,
}
#[cfg(target_os = "linux")]
pub(crate) async fn next(monitor: &mut Monitor) -> Result<bool, super::NetworkError> {
    use futures_util::StreamExt;
    monitor
        .signals
        .next()
        .await
        .and_then(|message| message.body().deserialize::<(bool,)>().ok())
        .map(|(sleeping,)| sleeping)
        .ok_or_else(|| super::NetworkError::new("NETWORK_POWER_MONITOR_UNAVAILABLE"))
}
#[cfg(not(target_os = "linux"))]
pub(crate) async fn next(_monitor: &mut Monitor) -> Result<bool, super::NetworkError> {
    std::future::pending().await
}
