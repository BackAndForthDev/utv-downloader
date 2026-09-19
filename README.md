# U-TV Downloader

Two things live in this folder, sharing one screen and one look:

- **The Chrome extension** — pick seasons or episodes of a u-tv.ru show and download them at the best quality the site
  offers. Chrome on Windows, macOS and Linux. Nothing else to install.
- **The website** (`index.html`) — the same screen for *watching*, with no downloading. It runs on anything with a
  browser, including a TV's own browser, and works with the remote's arrow keys.

## The website

Published with GitHub Pages: <https://backandforthdev.github.io/utv-downloader/>

A website can't read u-tv.ru directly (browsers don't let one site read another), so the episode list is prepared in
advance and kept in `catalog.json` next to the page. Videos are not copied anywhere: they play straight from u-tv's own
video server, which does allow it, at the best quality (usually 1080p). Only what u-tv.ru serves openly is listed;
region-locked episodes stay marked **Locked**.

### It keeps itself up to date

`.github/workflows/update-catalog.yml` runs `build-catalog.mjs` on GitHub every 3 hours, and commits `catalog.json` and
`descs.json` when anything changed. New episodes appear on the site by themselves — open it after a week or a year and
it's current. The page also re-checks the list every 20 minutes and on **↻ Refresh**.

To refresh it by hand (also useful if an episode is locked for GitHub's servers but plays for you), run this in the
folder and upload the two files it writes:

```bash
node build-catalog.mjs
```

### On a TV

Open the address in the TV's browser. **Arrows** move the pink selection, **OK** plays or opens, **Back** goes back.

Pressing play goes **straight to full screen**. **Back** leaves the episode in one press; **◀ ▶** skip 10 seconds and
**OK** pauses. ⚙ → *When you press play* → **In the page** turns that off. On a browser that refuses full screen, the
video fills the whole page instead, which on a TV is the same thing.

The ⏭ button plays the next episode, and the next one also starts by itself when an episode ends (staying full screen).
Every episode remembers where you stopped and continues there; finished ones are marked **✓ watched**.

HLS plays through the browser's own support; where there is none, the page loads hls.js by itself.

## The extension

### Install (once)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `utv-downloader` folder
4. Optional: click the puzzle icon in the toolbar and pin **U-TV Downloader**

After updating the files, click **Reload** on the extension in `chrome://extensions`.

### Use

1. Open any show or episode on u-tv.ru and click the extension icon. Clicking it anywhere else opens a searchable list of
   all shows (press `/` to jump to the search box). Star (☆) the shows you follow to keep them at the top.
2. Tick whole seasons or single episodes. Each row shows who the episode is about, its best available quality
   (usually 1080p, sometimes 4K) and its size.
3. Press **Download**. Canceling a download removes it from the list.

Files go to Chrome's download folder:

```
<Chrome download folder>/U-TV/<Show>/<Show> - S06E12.mp4
```

Keep the downloader tab open until the list says **Saved**. The file appears in the folder at that moment. You get a
notification when an episode finishes, and the toolbar icon shows the progress while downloads run.

### ▶ Watch (stream instead of downloading)

Click any episode's thumbnail (or ▶ in What's new) to play it right away at its best quality. Nothing is saved. It uses
the same fast connection trick as the downloads, so it plays smoothly where the site's own player may stall. From the
player you can press **⬇ Download** or **📺 Cast to TV**.

**On a TV:**
- The **website** above is the simplest route: open it in the TV's browser, nothing to install.
- **Cast to TV** uses Chrome's built-in casting. It appears when a TV with Google Cast (Chromecast / Google TV,
  including Hisense Google TV models) is on your network. The TV then pulls the stream itself.
- **AirPlay:** Chrome can't AirPlay on any system, so extensions can't either. Download as MP4 instead, then:
  - **Mac:** History → **▶ Play** opens it in QuickTime; press AirPlay.
  - **iPhone:** open the MP4 in Files and press AirPlay.
- **Windows:** download as MP4, then History → **▶ Play** (Films & TV → *Cast to device*), or right-click the file →
  *Cast to Device*. Most smart TVs, including Hisense, accept this.
- **Linux:** play the MP4 in VLC via *Playback → Renderer* (Chromecast).

### History

The **History** tab next to Downloads lists everything you've downloaded (from Chrome's own download list), with format,
size and date. **▶ Play** opens the file in your usual video player, and **Show file** opens its folder.

### Settings (⚙)

- **Save episodes as: MP4 or TS.** MP4 is the default: the same video and audio repackaged, with no re-encoding and no
  quality loss. It plays everywhere (TVs, phones, Topaz and other editors). TS is the original broadcast stream, byte
  for byte.
- **Episodes at once:** 1–3.
- **Theme:** System, Light or Dark. (The website has this one too, plus *When you press play*: full screen or in the page.)
- **Notifications** when a download finishes: on or off.

## What's new (right side, both)

- **★ Favourites**: the newest episodes of the shows you starred. This is the default once you've starred any.
  Episodes released since you last opened that show are marked **NEW** and counted on the tab and the show card
  (and, in the extension, on the toolbar icon, where **⬇ Download all new** grabs them in one click).
- **All of u-tv**: the site's own "Новые выпуски" strip.

## Related shows (Чадо из ада ↔ Предки ↔ Новые испытания)

Spin-offs named "<Show> - <Spin-off>" are linked to their original show by the people named in each episode's description:

- A Предки episode shows **↩ from Чадо из ада S05E08**. Click it to jump there. (In the extension, **+ Download** grabs
  the original and **✓ saved** means you already have it.)
- The original episode shows **↪ continues in Предки S01E07**.
- **probably … ?** means the match rests on a first name only. It's worth a quick look.
- **Find a name** (above the seasons) searches the episode descriptions of all related shows.

## Good to know

- Download speed: video pieces are fetched over several plain HTTP connections at once, the way download managers do.
  The CDN's HTTP/3 route measured about 6–10× slower on home Wi-Fi. If a network blocks plain HTTP, it switches to
  HTTPS by itself. (The website always uses HTTPS, which streaming handles fine.)
- If the connection drops, downloads wait and continue by themselves. A failed download's **Retry** picks up where it
  stopped.
- **Locked** means u-tv.ru blocks that episode for that location. Neither the extension nor the site gets around it:
  they only show what the connection can already play.
- Some older shows on the site are archive pages with no videos. They're marked "no videos" in the list.

## What's in the folder

| | |
|---|---|
| `index.html`, `web.js` | the website (uses `app.css` and `theme.js` too) |
| `catalog.json`, `descs.json` | the prepared episode list for the website |
| `build-catalog.mjs` | makes those two files by reading u-tv.ru |
| `.github/workflows/update-catalog.yml` | runs it on GitHub every 3 hours |
| `manifest.json`, `background.js`, `app.html`, `app.js` | the extension |
| `utv.js`, `hls.js`, `match.js`, `download.js`, `mp4.js`, `net.js` | shared parts: site parsing, streams, the name matcher, downloading, TS→MP4 |

For personal use. Not affiliated with u-tv.ru.
