# Changelog

All notable changes to Brain are documented here, newest first.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/). To update, see [Updating and uninstalling](README.md#updating-and-uninstalling).
Versions marked **Requires `npm run apple:setup`** change Brain Helper: run the command after updating and approve the permissions again.

## [0.17.2] - 2026-11-27

### Added
- Instant answers to "what time is it?" and "what's the date?" from the Mac's clock, without a model.
- A progress indicator while the local model reads a long conversation.
- A demo video, a speed table measured on a MacBook Air M4, update and uninstall instructions, and this changelog.

### Changed
- Asking to write to someone ("tell Omer that…", "text him") now brings in the messaging tools, even without the word "message".
- The local model receives only the current message's photos, so later messages in the conversation stay fast.
- The first message of a new conversation continues the prompt read that has already started, instead of restarting it.

### Fixed
- Both models said they had no access to messages when they did.
- A stalled local answer could run indefinitely. It now has length and time limits, and stops with a clear message.
- Phone numbers in approval cards were displayed backwards in right-to-left text.
- Bold text in the Hebrew README was rendered as asterisks.

## [0.17.1] - 2026-11-26

### Added
- Downloading email attachments (invoices, receipts, documents) from Gmail to the phone.

## [0.17.0] - 2026-11-23

**Requires `npm run apple:setup`** (camera permission).

### Added
- Sending photos and files from the phone, with the **+** button next to the message box.
- Taking a photo with the Mac's camera after approval. The photo is never sent to the cloud.
- Live view of the Mac's camera, for up to 5 minutes.
- MIT license.

### Fixed
- The content security policy blocked images on the iPhone.

## [0.16.1] - 2026-11-23

### Added
- README in English and Hebrew, with screenshots.
- Setup and usage guide.
- Privacy policy.

### Fixed
- Calendar event times were displayed in reverse order.
- A list directly after a line of text was not rendered as a list.
- The header showed "local" in cloud conversations.

## [0.16.0] - 2026-11-23

### Added
- iPhone notifications: an answer is ready, an action is waiting for approval, a coding agent has finished.
- Notifications are encrypted on the Mac before they leave it (Web Push, RFC 8291).

## [0.15.0] - 2026-11-23

**Requires `npm run apple:setup`** (Felipe Helper is replaced by Brain Helper).

### Changed
- Renamed from Felipe to Brain.
- Data moves automatically from `~/.felipe` to `~/.brain`.

[0.17.2]: https://github.com/nissimcoh/brain-assistant/releases/tag/v0.17.2
[0.17.1]: https://github.com/nissimcoh/brain-assistant/commit/0b05aba
[0.17.0]: https://github.com/nissimcoh/brain-assistant/commit/d85aa58
[0.16.1]: https://github.com/nissimcoh/brain-assistant/commit/7c01143
[0.16.0]: https://github.com/nissimcoh/brain-assistant/commit/67ec478
[0.15.0]: https://github.com/nissimcoh/brain-assistant/commit/3891d49
