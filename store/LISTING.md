# Chrome Web Store submission

Paste-ready answers for every field in the developer dashboard. Regenerate the images with `npm run store:assets`, and build the upload with `npm run package`.

## Package

Upload `ownyourtimeline.zip`, produced by `npm run package`. It contains the release build only, with no source maps and no debug logging.

## Store listing tab

**Name:** OwnYourTimeline

**Summary** (from the manifest, 132 characters max):
Filter your X Home feed with a plain-language instruction, classified by TypeSafe Jev.

**Category:** the social networking category.

**Language:** English

**Detailed description:**

```
OwnYourTimeline hides posts on your X (Twitter) Home timeline that break a rule you write in plain language.

Write one instruction, such as "Nothing political" or "No engagement bait or rage farming". OwnYourTimeline checks every post in your For you and Following feeds against it and removes the ones that don't fit before X shows them. You never see them flash on screen first.

HOW IT WORKS
• Posts are checked in batches by TypeSafe's Jev model, using your own TypeSafe API key.
• Text, quoted posts and images are all considered.
• If anything goes wrong, such as a timeout, a network error or a post the extension can't read, posts are shown normally. The extension never hides a post it couldn't check.
• Change your instruction or pause filtering at any time from the toolbar popup.

OPTIONAL FILTERED TAB
Turn on the Filtered tab to see what was hidden on the current page, right beside For you and Following.

PRIVACY
• No account, no server, no analytics. The developer receives none of your data.
• Post content and your instruction go directly from your browser to TypeSafe for classification.
• Your API key stays in your browser and is only sent to TypeSafe.

REQUIREMENTS
• A TypeSafe API key from console.typesafe.ai. Classification is billed to your TypeSafe account, normally one request per batch of posts X loads.
• Desktop Chrome or Edge 120 or later.

OwnYourTimeline is an independent project and is not affiliated with or endorsed by X Corp. or TypeSafe.
```

**Graphic assets:**

| Field | File |
|---|---|
| Store icon, 128x128 | `src/icons/icon128.png` |
| Screenshot 1, 1280x800 | `store/screenshot-1.png` |
| Screenshot 2, 1280x800 | `store/screenshot-2.png` |
| Small promo tile, 440x280 | `store/promo-small.png` |

The screenshots show the real extension UI running on a local test page with fictional demo posts. Up to five are allowed. Adding a screenshot of filtering on the real X site makes the listing stronger.

## Privacy practices tab

**Single purpose:**

```
OwnYourTimeline filters the user's X (Twitter) Home timeline: it removes posts that conflict with a plain-language instruction the user writes, using the user's own TypeSafe API key to classify each post.
```

**Permission justifications:**

`storage`
```
Saves the user's settings locally: the filtering instruction, whether filtering is on, whether the optional Filtered tab is shown, and the user's TypeSafe API key if they choose to remember it.
```

Host permissions, covering `https://api.typesafe.ai/*`, `https://pbs.twimg.com/*`, and the content scripts on `https://x.com/*` and `https://twitter.com/*`:
```
x.com and twitter.com: content scripts read the Home timeline data X loads (For you and Following) and remove posts that conflict with the user's instruction before X displays them. They also add the optional Filtered tab to the Home page. Other X pages are not modified.
api.typesafe.ai: the post text, images and the user's instruction are sent to TypeSafe's classification API, authenticated with the user's own API key. This is the extension's only network destination for user data.
pbs.twimg.com: images attached to timeline posts are downloaded, without cookies, so they can be resized and included in the classification request.
```

**Remote code:** No, I am not using remote code.

**Data usage**, collected data types. Tick these two:

- **Authentication information:** the user's TypeSafe API key is sent to TypeSafe to authenticate requests.
- **Website content:** text and images of X timeline posts are sent to TypeSafe for classification.

Leave every other category unticked. The extension handles no personally identifiable information, health, financial, communications, location, web history or user activity data.

**Certifications.** Tick all three. They are accurate because data only goes to TypeSafe to provide the filtering itself:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/raghavio/ownyourtimeline/blob/main/PRIVACY.md

## Distribution tab

Choose **Public** and the regions you want. The extension is free, and there are no in-app purchases.
