# OwnYourTimeline Privacy Policy

Effective November 2, 2026.

OwnYourTimeline is a browser extension that hides posts on your X (Twitter) Home timeline that conflict with an instruction you write. This policy explains what data the extension handles and where that data goes.

## Summary

- The developer of OwnYourTimeline runs no server and receives none of your data.
- To classify posts, the extension sends post content and your instruction directly from your browser to TypeSafe, using your own TypeSafe API key.
- Nothing is sold, shared for advertising, or used for any purpose other than filtering your timeline.

## Data the extension handles

**Timeline posts.** When you open X Home with filtering enabled, the extension reads the posts X sends to your browser for the For you and Following timelines. That includes text, quoted posts, image alt text, and images and video thumbnails. Author names, profile pictures and engagement counts are read only to display the optional Filtered tab. They are never sent anywhere.

**Your instruction.** The plain-language rule you write, such as "Nothing political".

**Your TypeSafe API key.** You supply the key. It is sent only to TypeSafe, as the credential for classification requests.

**Settings.** Whether filtering is on, and whether the Filtered tab is shown.

## Where data goes

**TypeSafe (api.typesafe.ai).** For each batch of timeline posts, the extension sends the post text, quoted text, images, image alt text and your instruction to TypeSafe's API. TypeSafe returns a score for each post. Requests are authenticated with your API key and billed to your TypeSafe account. TypeSafe's handling of this data is governed by [TypeSafe's privacy policy](https://typesafe.ai/privacy). At the time of writing, it states that TypeSafe does not train models on API inputs.

**X media servers (pbs.twimg.com).** To evaluate images, the extension downloads them from X's image server without cookies, then resizes them inside your browser before sending them to TypeSafe.

No other party receives any data. The extension contains no analytics, telemetry, advertising or crash reporting.

## Storage on your device

- **Settings and instruction** are kept in the browser's extension storage until you change them or uninstall the extension.
- **The API key** lasts only for the current browser session by default. If you tick "Remember key on this device", it is kept in extension storage until you remove it or uninstall the extension. Web pages, including X, cannot read this storage. It is not encrypted.
- **Classification results and the Filtered tab** exist only in memory for the current page. They are discarded when you reload or close the tab.

## Your choices

- Turn filtering off at any time in the extension's popup. While it is off, nothing is sent to TypeSafe.
- Remove your API key with **Remove key** in the popup.
- Uninstalling the extension deletes all of its stored data.
- To have data deleted at TypeSafe, contact TypeSafe as described in their privacy policy.

## Children

OwnYourTimeline is not directed at children under 13 and does not knowingly process their data.

## Changes

If this policy changes, the updated version will be published at this address with a new effective date.

## Contact

Questions about this policy: raghavsharma@outlook.in
