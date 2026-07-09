use super::*;
use chrono::TimeZone;

/// Wall-clock aware sleep that survives system suspend/hibernate.
///
/// Unlike `tokio::time::sleep(duration)` which uses monotonic time (pauses during
/// system sleep on macOS), this function polls `Utc::now()` (wall clock) every
/// POLL_INTERVAL seconds, correctly detecting that the scheduled time has passed
/// even after the system wakes from sleep.
///
/// Returns `true` if target time was reached, `false` if shutdown was requested.
pub(super) async fn sleep_until_wallclock(
    target: DateTime<Utc>,
    shutdown: &RwLock<bool>,
    task_id: &str,
) -> bool {
    const POLL_SECS: u64 = 30;
    loop {
        let now = Utc::now();
        if now >= target {
            return true;
        }
        // Check shutdown flag
        if *shutdown.read().await {
            ulog_info!(
                "[CronTask] Task {} wallclock sleep interrupted by shutdown",
                task_id
            );
            return false;
        }
        // Sleep for min(remaining, POLL_SECS) — short sleeps survive system suspend
        let remaining_secs = (target - now).num_seconds().max(0) as u64;
        let sleep_secs = remaining_secs.min(POLL_SECS).max(1);
        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
    }
}

/// Advance an interval target to the first future occurrence after `now`.
///
/// This is used for recurring schedules with an explicit anchor (`start_at`).
/// Missing a window due to app shutdown or system sleep should skip the missed
/// occurrence instead of firing immediately at the wrong wall-clock time.
pub(super) fn advance_interval_target_after(
    candidate: DateTime<Utc>,
    interval_secs: i64,
    now: DateTime<Utc>,
) -> DateTime<Utc> {
    if candidate > now {
        return candidate;
    }
    let interval_secs = interval_secs.max(1);
    let behind_secs = (now - candidate).num_seconds().max(0);
    let steps = behind_secs / interval_secs + 1;
    candidate
        .checked_add_signed(chrono::Duration::seconds(
            interval_secs.saturating_mul(steps),
        ))
        .unwrap_or_else(|| now + chrono::Duration::seconds(interval_secs))
}

pub(super) fn resolve_missed_interval_target(
    candidate: DateTime<Utc>,
    interval_secs: i64,
    now: DateTime<Utc>,
    catch_up_window: Option<&RecurringWindow>,
    min_ahead_secs: i64,
) -> DateTime<Utc> {
    if candidate > now {
        return candidate;
    }
    if let Some(window) = catch_up_window {
        if let Some(next) = next_catch_up_window_target(now, window, min_ahead_secs) {
            return next;
        }
    }
    advance_interval_target_after(candidate, interval_secs, now)
}

fn next_catch_up_window_target(
    now: DateTime<Utc>,
    window: &RecurringWindow,
    min_ahead_secs: i64,
) -> Option<DateTime<Utc>> {
    use chrono::Timelike;

    let tz = window.timezone.parse::<chrono_tz::Tz>().ok()?;
    let start = parse_hhmm(&window.start)?;
    let end = parse_hhmm(&window.end)?;
    if start == end {
        return None;
    }

    let local = now.with_timezone(&tz);
    let minutes = local.hour() * 60 + local.minute();
    let min_target = now + chrono::Duration::seconds(min_ahead_secs.max(1));

    if is_in_window(minutes, start, end) {
        let end_date = if start < end || minutes < end {
            local.date_naive()
        } else {
            local.date_naive().checked_add_days(chrono::Days::new(1))?
        };
        let end_utc = local_time_to_utc(&tz, end_date, end)?;
        if min_target < end_utc {
            return Some(min_target);
        }
    }

    let target_date = if start < end {
        if minutes < start {
            local.date_naive()
        } else {
            local.date_naive().checked_add_days(chrono::Days::new(1))?
        }
    } else if minutes < start && minutes >= end {
        local.date_naive()
    } else {
        local.date_naive().checked_add_days(chrono::Days::new(1))?
    };
    let candidate = local_time_to_utc(&tz, target_date, start)?;
    if candidate > now {
        Some(candidate)
    } else {
        let next_date = target_date.checked_add_days(chrono::Days::new(1))?;
        local_time_to_utc(&tz, next_date, start)
    }
}

fn local_time_to_utc(
    tz: &chrono_tz::Tz,
    date: chrono::NaiveDate,
    minutes: u32,
) -> Option<DateTime<Utc>> {
    let naive = date.and_hms_opt(minutes / 60, minutes % 60, 0)?;
    match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt.with_timezone(&Utc)),
        chrono::LocalResult::Ambiguous(early, _) => Some(early.with_timezone(&Utc)),
        chrono::LocalResult::None => (1..=120).find_map(|offset| {
            let adjusted = naive + chrono::Duration::minutes(offset);
            match tz.from_local_datetime(&adjusted) {
                chrono::LocalResult::Single(dt) => Some(dt.with_timezone(&Utc)),
                chrono::LocalResult::Ambiguous(early, _) => Some(early.with_timezone(&Utc)),
                chrono::LocalResult::None => None,
            }
        }),
    }
}

fn is_in_window(minutes: u32, start: u32, end: u32) -> bool {
    if start < end {
        minutes >= start && minutes < end
    } else {
        minutes >= start || minutes < end
    }
}

fn parse_hhmm(s: &str) -> Option<u32> {
    let (hour, minute) = s.split_once(':')?;
    let hour: u32 = hour.parse().ok()?;
    let minute: u32 = minute.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(hour * 60 + minute)
}

/// Compute the next execution time for a cron task (enrichment helper).
/// Returns an RFC3339 string or None if the task is stopped / no schedule.
///
/// v0.1.69 cross-review: past-due values (cold start before first execution,
/// or catch-up after system sleep) used to be returned verbatim — e.g. an
/// `At` task whose target time has passed returned the stale timestamp, a
/// cold-started `Every` task returned `created_at + interval` even though
/// the scheduler actually fires `~2 s` after spawn. SummaryCard now prefers
/// this value over its own cron-parser, so stale timestamps would show
/// "下次触发 5 分钟前" — obviously wrong. Fix: clamp any past-due result
/// forward to match the scheduler's own "fire in 2s / 5s" fallback in
/// `start_task_scheduler`'s `initial_target` block, so the UI and the
/// scheduler agree.
pub(super) fn compute_next_execution(task: &CronTask) -> Option<String> {
    if task.status != TaskStatus::Running {
        return None;
    }

    // Mirror of scheduler's `initial_target` fallback (cron_task.rs ~912):
    // cold-start / first-execution with no better signal fires +2s; past-due
    // fires +5s. `clamp_forward` keeps `compute_next_execution` in lockstep
    // with those minimums so the UI never displays a moment in the past.
    fn clamp_forward(candidate: DateTime<Utc>, min_ahead_secs: i64) -> DateTime<Utc> {
        let min_target = Utc::now() + chrono::Duration::seconds(min_ahead_secs);
        if candidate > min_target {
            candidate
        } else {
            min_target
        }
    }

    match &task.schedule {
        Some(CronSchedule::At { at }) => {
            // One-shot. Past-due → scheduler fires in ~2s after spawn.
            match DateTime::parse_from_rfc3339(at)
                .or_else(|_| DateTime::parse_from_str(at, "%Y-%m-%dT%H:%M:%S"))
            {
                Ok(target) => Some(clamp_forward(target.with_timezone(&Utc), 2).to_rfc3339()),
                Err(_) => None,
            }
        }
        Some(CronSchedule::Every {
            minutes,
            start_at,
            catch_up_window,
        }) => {
            // Explicit `start_at` (future) wins for the first execution.
            if let Some(ref sa) = start_at {
                if let Ok(parsed) = DateTime::parse_from_rfc3339(sa) {
                    let target = parsed.with_timezone(&Utc);
                    let interval_secs = (*minutes).max(5) as i64 * 60;
                    let now = Utc::now();
                    if task.execution_count == 0 {
                        return Some(
                            resolve_missed_interval_target(
                                target,
                                interval_secs,
                                now,
                                catch_up_window.as_ref(),
                                2,
                            )
                            .to_rfc3339(),
                        );
                    }
                    if let Some(last_exec) = task.last_executed_at {
                        return Some(
                            resolve_missed_interval_target(
                                last_exec + chrono::Duration::seconds(interval_secs),
                                interval_secs,
                                now,
                                catch_up_window.as_ref(),
                                5,
                            )
                            .to_rfc3339(),
                        );
                    }
                }
            }
            // First ever run with no last_executed_at → scheduler fires +2s.
            if task.execution_count == 0 && task.last_executed_at.is_none() {
                return Some((Utc::now() + chrono::Duration::seconds(2)).to_rfc3339());
            }
            let base = task.last_executed_at.unwrap_or(task.created_at);
            let next = base + chrono::Duration::minutes(*minutes as i64);
            // Past-due (catch-up after sleep) → scheduler fires +5s.
            Some(clamp_forward(next, 5).to_rfc3339())
        }
        Some(CronSchedule::Cron { expr, tz }) => match next_cron_fire_time(expr, tz.as_deref()) {
            Ok(next) => Some(next.to_rfc3339()),
            Err(_) => None,
        },
        Some(CronSchedule::Loop) => {
            // Goal Mode: no scheduled time, triggered by completion
            None
        }
        None => {
            // Legacy: use interval_minutes — same cold-start clamp as `Every`.
            if task.execution_count == 0 && task.last_executed_at.is_none() {
                return Some((Utc::now() + chrono::Duration::seconds(2)).to_rfc3339());
            }
            let base = task.last_executed_at.unwrap_or(task.created_at);
            let next = base + chrono::Duration::minutes(task.interval_minutes as i64);
            Some(clamp_forward(next, 5).to_rfc3339())
        }
    }
}

/// Enrich a CronTask with computed next_execution_at
pub(super) fn enrich_task(mut task: CronTask) -> CronTask {
    task.next_execution_at = compute_next_execution(&task);
    task
}

/// Public alias for `enrich_task` used by management_api projection paths
/// that don't go through the manager's accessor methods (e.g. echoing the
/// just-updated task back from `update_cron_handler`). Issue #115.
pub fn enrich_for_summary(task: CronTask) -> CronTask {
    enrich_task(task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn shanghai_night_window() -> RecurringWindow {
        RecurringWindow {
            timezone: "Asia/Shanghai".to_string(),
            start: "21:00".to_string(),
            end: "09:00".to_string(),
        }
    }

    #[test]
    fn missed_window_catches_up_at_next_window_start_not_next_full_interval() {
        let candidate = Utc.with_ymd_and_hms(2026, 7, 1, 13, 0, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 7, 2, 7, 0, 0).unwrap();
        let next = resolve_missed_interval_target(
            candidate,
            14 * 24 * 60 * 60,
            now,
            Some(&shanghai_night_window()),
            5,
        );

        assert_eq!(next, Utc.with_ymd_and_hms(2026, 7, 2, 13, 0, 0).unwrap());
    }

    #[test]
    fn missed_window_catches_up_immediately_when_still_inside_window() {
        let candidate = Utc.with_ymd_and_hms(2026, 7, 1, 13, 0, 0).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 7, 2, 15, 0, 0).unwrap();
        let next = resolve_missed_interval_target(
            candidate,
            14 * 24 * 60 * 60,
            now,
            Some(&shanghai_night_window()),
            5,
        );

        assert_eq!(next, now + chrono::Duration::seconds(5));
    }
}
