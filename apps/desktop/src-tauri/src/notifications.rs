#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationPermission {
    Granted,
    Denied,
    NotDetermined,
    Unsupported,
}

#[tauri::command]
pub async fn notification_permission() -> Result<NotificationPermission, String> {
    platform::permission().await
}

#[tauri::command]
pub async fn request_notification_permission() -> Result<NotificationPermission, String> {
    platform::request_permission().await
}

#[tauri::command]
pub async fn send_notification(title: String, body: String) -> Result<(), String> {
    platform::send(title, body).await
}

#[cfg(target_os = "macos")]
mod platform {
    use super::NotificationPermission;
    use block2::RcBlock;
    use objc2::{rc::Retained, runtime::Bool};
    use objc2_foundation::{NSBundle, NSError, NSString, NSUUID};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent,
        UNNotificationRequest, UNNotificationSettings, UNNotificationSound,
        UNUserNotificationCenter,
    };
    use std::{ptr::NonNull, sync::Mutex};
    use tokio::sync::oneshot;

    fn center() -> Option<Retained<UNUserNotificationCenter>> {
        // The centre raises an Objective-C exception in an unbundled executable.
        let identifier = NSBundle::mainBundle().bundleIdentifier()?;
        if identifier.is_empty() {
            return None;
        }
        Some(UNUserNotificationCenter::currentNotificationCenter())
    }

    fn complete<T>(sender: &Mutex<Option<oneshot::Sender<T>>>, result: T) {
        if let Some(sender) = sender
            .lock()
            .expect("notification completion mutex poisoned")
            .take()
        {
            let _ = sender.send(result);
        }
    }

    fn completion_result(error: *mut NSError) -> Result<(), String> {
        // The callback owns the borrowed error; convert it before returning.
        match unsafe { error.as_ref() } {
            Some(error) => Err(error.localizedDescription().to_string()),
            None => Ok(()),
        }
    }

    fn permission_from_status(
        status: UNAuthorizationStatus,
    ) -> Result<NotificationPermission, String> {
        match status {
            UNAuthorizationStatus::Authorized => Ok(NotificationPermission::Granted),
            UNAuthorizationStatus::Denied => Ok(NotificationPermission::Denied),
            UNAuthorizationStatus::NotDetermined => Ok(NotificationPermission::NotDetermined),
            UNAuthorizationStatus::Provisional | UNAuthorizationStatus::Ephemeral => {
                Ok(NotificationPermission::Granted)
            }
            _ => Err(format!(
                "Unknown notification authorization status: {}",
                status.0
            )),
        }
    }

    pub async fn permission() -> Result<NotificationPermission, String> {
        let receiver = {
            let Some(center) = center() else {
                return Ok(NotificationPermission::Unsupported);
            };
            let channel = oneshot::channel();
            let sender = Mutex::new(Some(channel.0));
            let completion = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
                // UserNotifications guarantees a valid settings object during the callback.
                let status = unsafe { settings.as_ref() }.authorizationStatus();
                complete(&sender, permission_from_status(status));
            });
            center.getNotificationSettingsWithCompletionHandler(&completion);
            channel.1
        };
        receiver
            .await
            .map_err(|error| format!("Notification settings callback failed: {error}"))?
    }

    pub async fn request_permission() -> Result<NotificationPermission, String> {
        let receiver = {
            let Some(center) = center() else {
                return Ok(NotificationPermission::Unsupported);
            };
            let channel = oneshot::channel();
            let sender = Mutex::new(Some(channel.0));
            let completion = RcBlock::new(move |_granted: Bool, error: *mut NSError| {
                complete(&sender, completion_result(error));
            });
            center.requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &completion,
            );
            channel.1
        };
        receiver
            .await
            .map_err(|error| format!("Notification authorization callback failed: {error}"))??;
        permission().await
    }

    pub async fn send(title: String, body: String) -> Result<(), String> {
        if !matches!(permission().await?, NotificationPermission::Granted) {
            return Err("System notification permission is not granted".to_owned());
        }
        let receiver = {
            let center = center().ok_or("System notifications require an app bundle")?;
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&title));
            content.setBody(&NSString::from_str(&body));
            content.setSound(Some(&UNNotificationSound::defaultSound()));
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSUUID::new().UUIDString(),
                &content,
                None,
            );
            let channel = oneshot::channel();
            let sender = Mutex::new(Some(channel.0));
            let completion = RcBlock::new(move |error: *mut NSError| {
                complete(&sender, completion_result(error));
            });
            center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
            channel.1
        };
        receiver
            .await
            .map_err(|error| format!("Notification delivery callback failed: {error}"))?
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn maps_authorization_status_and_rejects_unknown_values() {
            assert!(matches!(
                permission_from_status(UNAuthorizationStatus::Authorized),
                Ok(NotificationPermission::Granted)
            ));
            assert!(matches!(
                permission_from_status(UNAuthorizationStatus::Denied),
                Ok(NotificationPermission::Denied)
            ));
            assert!(matches!(
                permission_from_status(UNAuthorizationStatus::NotDetermined),
                Ok(NotificationPermission::NotDetermined)
            ));
            assert!(permission_from_status(UNAuthorizationStatus(99)).is_err());
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::NotificationPermission;

    pub async fn permission() -> Result<NotificationPermission, String> {
        Ok(NotificationPermission::Unsupported)
    }

    pub async fn request_permission() -> Result<NotificationPermission, String> {
        Ok(NotificationPermission::Unsupported)
    }

    pub async fn send(_title: String, _body: String) -> Result<(), String> {
        Err("System notifications are unsupported on this platform".to_owned())
    }
}
