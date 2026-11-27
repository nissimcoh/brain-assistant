# Changelog

Updating is `git pull`, `npm test`, `npm run service:install`. When a version says **Run `npm run apple:setup`**, do that too:
Brain Helper changed, and macOS asks for its permissions again.

## 0.17.2

- **Messages:** "תשלח לעומר שאני בדרך" (tell Omer I'm on my way) now offers to send a message, even without the word "message".
  Before, Brain could find the contact but said it couldn't send.
- **Instant answers:** "מה השעה?" and "איזה יום היום?" come from the Mac's clock, without the model.
- **No silent hangs:** a local answer that runs on with nothing to show is stopped after a limit, with a clear message and an offer
  to try the cloud. While the Mac reads a long conversation, the app shows how long it has been.
- **Faster with photos on the Mac:** only the current message's photos go to the local model, so later messages in the same
  conversation don't re-read everything.
- **Faster new conversations:** the first message waits for the instructions the Mac already started reading, instead of starting over.
- **Fixed:** phone numbers in approval cards were shown backwards ("972…+").

## 0.17.1

- **Email attachments:** download an attached invoice, receipt or document from Gmail to the phone.

## 0.17.0

**Run `npm run apple:setup`** (the camera permission).

- **Photos and files from the phone:** the **+** next to the message box. The local model sees photos; documents are read on the Mac.
- **The Mac's camera:** a photo after approval, and a live view while you watch (up to 5 minutes). Never sent to the cloud.
- MIT license.

## 0.16.1

- README in English and Hebrew, a step-by-step guide with screenshots, and a privacy policy.

## 0.16.0

- **iPhone notifications**, end-to-end encrypted on the Mac (Web Push, RFC 8291).

## 0.15.0

**Run `npm run apple:setup`** (Felipe Helper became Brain Helper).

- The assistant was renamed from Felipe to Brain. Data moves from `~/.felipe` to `~/.brain` by itself.
