# Privacy Policy

[עברית](PRIVACY.he.md) · [Back to README](README.md)

**Effective: November 23, 2026** (updated for photos, files and the Mac's camera in version 0.17)

## The short version

- **Brain runs on your own Mac.** There is no Brain server, no Brain account and no Brain company in the middle.
  The author of this software never receives your data: not your messages, not your mail, not usage statistics.
- **Your data stays on your Mac** unless you choose otherwise: conversations, memory, the activity log, your keys and
  your Google permissions are all kept there.
- **Nothing leaves the Mac without a reason you can see:** a cloud model only when you ask for it (and only the
  kinds of data you allow), Google only for your own mail and calendar, Apple's push service only as encrypted notifications.
- **No analytics, no telemetry, no ads, no tracking.** Brain does not phone home.
- **Nothing is changed or sent on your behalf without your approval** on a card that shows the recipient and the exact text.
- **The Mac's camera works only when you ask:** a photo after you approve it, or a live view while you watch it.
  Photos from the Mac's camera never leave the Mac.

## Who this policy is about

Brain is open software that you install and run yourself. "You" are both the person using it and the person
operating it. When you connect Google, you create your own OAuth client in your own Google Cloud project, so the
"app" Google asks you to trust is yours, not the author's. This policy describes what the software does with data,
so you can decide what to connect.

## What Brain handles, and where it is kept

| Data | Where it is kept | Leaves the Mac? |
| --- | --- | --- |
| Your conversations, including what Brain read to answer (parts of emails, events, files, web pages) | `~/.brain/brain.db` on the Mac | Only to a cloud model, if you use one and allow that kind of data |
| Memory (facts you asked Brain to remember) | `~/.brain/brain.db` | Only to a cloud model, if you allow "memory" |
| Activity log (tools used, approvals, cloud requests and their estimated cost) | `~/.brain/brain.db` | No |
| Google permissions (OAuth tokens) | The macOS Keychain | Only to Google, to call Google's APIs |
| Your Google OAuth client file | `~/.brain/google-client.json` | No |
| Cloud and web-search keys | `~/.brain/config.json` (readable only by you) | Only to the provider they belong to |
| Paired devices | `~/.brain/brain.db`, tokens stored only as hashes | No |
| Notification keys and subscriptions | `~/.brain/brain.db`; the Mac's private signing key never leaves it | Encrypted notifications go to the push service |
| Calendar, reminders, contacts, notes, messages, files | Where they already are (Apple apps, iCloud, your disk). Brain reads them when a request needs them | Only what a request needs, as described below |
| Photos and files you send from the phone | `~/.brain/uploads` (readable only by you), with their conversation. Text read from a document is kept in `brain.db` | Only to a cloud model, as part of your message in a conversation that's in the cloud |
| Photos from the Mac's camera | `~/.brain/uploads`, with their conversation | Never. Not even in a conversation that's in the cloud |
| Live view from the Mac's camera | Not stored. Frames pass through a temporary folder in `~/.brain` that is deleted when the view stops | Only to your paired phone, while you watch |
| On the iPhone | The pairing token, unsent drafts, the app's own files, files you asked Brain to send you, and photos you opened | Cleared when you disconnect the device |

The folder `~/.brain` is created readable only by you. We recommend turning on FileVault, which encrypts the whole disk.

## What leaves the Mac, and to whom

### A cloud model (Anthropic or OpenAI): only if you turn it on

Without a cloud key, nothing is ever sent to a model provider: the local model (Ollama) answers on the Mac.

With a key, by default the Mac still answers. A conversation goes to the cloud only when you ask ("move to the cloud",
the Mac/Cloud switch) or accept the suggestion card for a complex task, or if you chose "Always in the cloud".
For such a conversation, Brain sends:

- your messages in that conversation and its answers, including photos and documents you attached to them;
- Brain's instructions (the date, the tools' descriptions, and your memory if you allow "memory");
- results of tools that ran, **only for the kinds of data you allow** in Settings → Cloud:
  memory and past conversations; calendar, reminders, contacts, notes and messages; files and coding agents; mail.

A kind of data that's off is never sent: its tools aren't offered to the cloud model, and results of that kind
(even from earlier in a conversation that started on the Mac) are replaced with a short note before the conversation
leaves the Mac. Brain never sends your keys, your Google permissions, other conversations, or photos from the Mac's camera.
The tools themselves always run on the Mac, and every action still waits for your approval.

What the provider does with it is governed by its own terms. For API use, as of this policy's date:
Anthropic does not use API inputs and outputs to train its models by default, and deletes them within 30 days,
except where needed to enforce its usage policy or required by law
([Anthropic](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)).
OpenAI does not use API data for training, and keeps abuse-monitoring logs for up to 30 days
([OpenAI](https://developers.openai.com/api/docs/guides/your-data)). Check these pages yourself: they can change.

### Google: only your own account, only what a request needs

When you connect Google, Brain uses the Gmail, Google Calendar and People APIs to search and read your mail (and fetch an
attachment you ask for, which is then kept with that conversation like a file you sent), read your calendars and contacts, and, after your approval, send mail, mark mail as read and create events.
It talks to Google directly from your Mac; no other server is involved. Brain does not sell Google user data,
does not use it for advertising, and does not let humans read it. It is used only to answer your requests,
shown to you in the app, and sent to a cloud model only if you allow "mail" (for Gmail) or "calendar…" (for calendar and contacts).

Brain's use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

You can disconnect an account in Settings → Mail and calendar (this revokes the permission at Google too), or at
<https://myaccount.google.com/permissions>.

### Apple's push service: encrypted notifications

If you turn on notifications, the Mac sends them through Apple's push service. Each notification is encrypted on the Mac
for one device ([RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)), so Apple can deliver it but cannot read it.
Brain sends only to the real push services (Apple, Google, Mozilla, Microsoft), and a disconnected device gets nothing.
A notification may show the start of a reply on your lock screen; turn off "Show the start of the reply" if you'd rather it didn't.

### Web search: your search words

When Brain searches the web, the words it searches for go to Tavily (if you added a key) or DuckDuckGo, and the pages it
reads are fetched from your Mac. Brain refuses to fetch addresses on your Mac or your home network.

### Tailscale: the connection between your devices

Your phone reaches the Mac through Tailscale. The traffic is encrypted between your devices; Tailscale's coordination
service knows which devices are on your network, not what they say to each other.

### The Mac's camera: only when you ask, never to the cloud

Brain reaches the Mac's camera through Brain Helper, which holds the camera permission (you grant it once, on the Mac).

- **A photo:** when you ask ("take a photo from the Mac"), Brain shows an approval card first. Only after you approve
  does it take one photo. The photo is kept with the conversation and shown to the model on the Mac, so it can describe it.
  It is never sent to a cloud model.
- **Live view:** menu → Mac camera. Frames go only to the phone that is watching, only while that screen is open,
  for up to 5 minutes at a time. Leaving the app or closing the screen stops it. Nothing is recorded or kept.
  The model cannot start a live view.
- **You can always tell:** macOS lights the green light next to the camera whenever it's in use, Brain shows a notification
  on the Mac when a live view starts ("live view of the Mac's camera from iPhone"), and every photo and live view is
  in the activity log.
- **Other people:** the camera may see people who live with you or visit. Let them know the Mac's camera can be used this way.

To turn it off: System Settings → Privacy & Security → Camera → Brain Helper.

### Apple apps and coding agents: on the Mac

Calendar, Reminders, Contacts, Notes and Messages are reached through Brain Helper, a small app on the Mac with no
network access. Messages you approve are sent by the Messages app as usual. Claude Code and Codex conversations are read
from their folders on the Mac; a message you approve is passed to the agent on the Mac, which then works with its
own settings and its own provider's terms.

## What Brain never does

- It doesn't read `.ssh`, `.gnupg`, `.aws`, the Keychain, browser data, the Messages and Mail databases, or `~/.brain` itself.
- It doesn't edit files, and never deletes them: "delete" means moving to the Trash, after your approval.
- It doesn't save passwords, card or account numbers, or ID numbers to memory, even if asked.
- It doesn't follow instructions found inside emails, web pages, files or events: those are treated as data.
- It doesn't send, create, change or move anything without your approval on a card.

## Keeping and deleting your data

You decide how long data is kept. Nothing is deleted on a schedule, and nothing needs to be requested from anyone:

- **A conversation:** menu → ⋯ next to it → Delete. Its photos and files are deleted from the Mac with it.
- **A photo or file you started to send but didn't:** deleted from the Mac automatically after a day.
- **A fact in memory:** menu → Memory → 🗑.
- **A device:** on that device, menu → Disconnect this device. Its token stops working at once.
- **Google:** Settings → Mail and calendar → Disconnect (also revokes it at Google).
- **Apple:** System Settings → Privacy & Security → Brain Helper.
- **Cloud and search keys:** `npm run cloud:key -- anthropic --remove`, `npm run web:key -- --remove`.
- **Everything:** `npm run service:uninstall`, then delete the `~/.brain` folder and `~/Applications/Brain Helper.app`.

Data a cloud provider received is kept by that provider according to its own policy (see above).

## Children

Brain is not designed for children and is meant to be run by an adult on their own computer.

## Changes

Changes to this policy are made in this file, and its history is visible in the repository.
The date at the top shows when it last changed.

## Contact

Questions or concerns: open an issue at <https://github.com/nissimcoh/brain-assistant/issues>.
Please don't include personal information in an issue.
