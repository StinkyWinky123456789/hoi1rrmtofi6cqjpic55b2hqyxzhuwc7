# Meme Engine

Automated content pipeline for the four meme pages: **Gym Goblin, S-Rank Memes, Buy High Sell Low and Barely Functioning**.

Every Saturday it collects trends, has Claude write and score twice as many memes as needed, keeps the best 35 per page (5 a day), renders images, carousels and finished Reel videos, and puts them in a review queue. You approve or fix them from your PC or phone. Approved posts go out on schedule, about every 20 minutes, through Instagram's official API, even when your computer is off. After posts go live, their reach and DM shares are fed back into next week's writing.

```
Sat 10:15 AM ET   Trends ─► Claude writes ~75 per page ─► de-dupe ─► Claude scores ─► best 35 per page
                  ─► render JPEGs, carousels, MP4 Reels ─► review queue
Sat to Mon        You review: approve / reject / edit text / swap footage or audio / use your own clip
Every 20 min      Publisher posts the next approved post for each page (never two within 90 min)
2 and 7 days on   Instagram insights (reach, shares, saves) ─► "what worked" for next week's prompt
```

**Volume:** 5 posts a day per page = 35 a week = 140 per page every 4 weeks. Each page's week has 7 Reels, 4 carousels and 24 images (change this in `config/pages.json`).

## Monthly cost

| Item | Cost |
|---|---|
| Claude API (Sonnet 5.5 writes and scores about 300 memes a week) | about $3 to $5 a month |
| X API trend reads (hard cap of 2,000 reads a month, $0.005 each) | up to $10 a month |
| GitHub Actions, GitHub Pages (public repo), Pexels footage, Instagram API | free |

## Safety rules built in

- **Nothing posts without your approval**, and the approval is tied to the exact image or video you saw. If a post is re-rendered after you approve it, it goes back to "needs review".
- **Dry run by default.** Until you set `PUBLISH_ENABLED` to `true`, the publisher only logs what it *would* post.
- Posts left unapproved more than 12 hours past their time are marked *missed* rather than dumped late.
- Never two posts from one page within 90 minutes. If a post fails 3 times, GitHub emails you about the failed run.
- Every meme is original, which keeps the pages within Instagram's originality rule (no more than 10 unoriginal posts in 30 days). Trends and X posts are used as **topics only**, and anything too close to someone else's post is dropped automatically.

---

## One-time setup (about 1 to 2 hours)

### 1. Instagram accounts
Create the four accounts. In each one go to **Settings → Account type and tools → Switch to professional account → Business**. Business accounts get full API support for posting, Reels and insights.

### 2. GitHub repository
1. Create a free GitHub account, then a **public** repository named `meme-engine`. It must be public so GitHub Pages and Actions are free. Your upcoming post queue will be visible to anyone who finds the repo.
2. Upload everything in this folder. On github.com use **Add file → Upload files** and drag the folder contents in, including the hidden `.github` folder. With Git, run `git push`.
3. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
4. **Settings → Actions → General → Workflow permissions: Read and write permissions.**

### 3. Meta (Instagram) developer app
1. Go to [developers.facebook.com](https://developers.facebook.com), choose **My Apps → Create app**, and pick the Instagram use case. Meta renames these options often; pick the one that includes the *Instagram API*.
2. Open **Instagram → API setup with Instagram business login**.
3. Under **App roles → Roles**, add each of your four Instagram accounts as an **Instagram tester**, and accept the invite in each account (Settings → Apps and websites).
4. Back in API setup, click **Add account** / **Generate token** for each account. Copy the **Instagram user ID** and the **access token** for each one. The token needs `instagram_business_basic`, `instagram_business_content_publish` and `instagram_business_manage_insights`.
5. For accounts you own and have added as testers, the app can usually stay in development mode with no App Review. If Meta asks for review, follow its prompts.

### 4. Other keys
| Service | Where | Notes |
|---|---|---|
| Claude API | [platform.claude.com](https://platform.claude.com) → API keys | Add $10 of credit and set a monthly spend limit |
| X API | [developer.x.com](https://developer.x.com) → your app → Bearer token | Buy a small credit pack; the engine stops itself at 2,000 reads a month |
| Pexels | [pexels.com/api](https://www.pexels.com/api/) | Free; provides the stock footage behind Reels |

### 5. Add the secrets
In the repo: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key |
| `X_BEARER_TOKEN` | X bearer token |
| `PEXELS_API_KEY` | Pexels key |
| `IG_USER_ID_GYM`, `IG_TOKEN_GYM` | Gym Goblin's Instagram user ID and token |
| `IG_USER_ID_ANIME`, `IG_TOKEN_ANIME` | S-Rank Memes |
| `IG_USER_ID_MONEY`, `IG_TOKEN_MONEY` | Buy High Sell Low |
| `IG_USER_ID_RELATABLE`, `IG_TOKEN_RELATABLE` | Barely Functioning |
| `GH_PAT` | Optional but recommended: a fine-grained GitHub token for this repo with **Secrets: Read and write**, so Instagram tokens renew themselves every 2 weeks (they expire after 60 days) |

On the **Variables** tab, add `PUBLISH_ENABLED` = `false` for now.

### 6. Add music for Reels (recommended)
Reels posted through the API **can't use Instagram's trending audio**, so the engine adds your own tracks. Download royalty-free MP3s (for example from [Pixabay Music](https://pixabay.com/music/), which allows social media use) and put them in `assets/audio/dramatic`, `hype`, `chill`, `sad` or `funny`. Claude picks a mood for each Reel. With no tracks, Reels are silent.

### 7. Open the review queue
1. Create a second fine-grained GitHub token for this repo with **Contents: Read and write**. This one is for the review app.
2. Go to **Actions → Generate next week → Run workflow**. It takes about 10 to 20 minutes.
3. Open `https://<your-github-username>.github.io/meme-engine/`, click **Settings**, and enter `yourname/meme-engine` and the token. Bookmark it on your phone too.

### 8. Go live
Leave `PUBLISH_ENABLED` as `false` for the first day and check **Actions → Publish**: the logs show what it would have posted and when. When it looks right, change the variable to `true`.

---

## Weekly routine (about 20 to 40 minutes)
- **Saturday:** next week's 140 posts arrive in the review queue.
- **Saturday to Monday morning:** review them. Use **Videos to review** to clear the Reels in one pass, and **Approve all shown scoring ≥ 8** to clear the strongest images quickly. Keys: `J`/`K` move, `A` approve, `R` reject, `E` edit, `Space` play the video.
- **Editing:** caption edits save instantly. Text edits, **Swap footage**, **Swap audio** and **Use my own clip** re-render within about 20 minutes, then the post needs approving again.
- The first slot each week is Monday 6:30 AM ET (Gym Goblin), so finish reviewing by then.

## Changing things
Everything lives in `config/pages.json`: names, handles, colors, posting times (Eastern), posts per day, which slot is the Reel, carousel days, hashtags, X search queries, the Claude model and the X monthly cap.

## Good to know
- GitHub's scheduled jobs can run 5 to 30 minutes late at busy times, so posts land near their slot, not to the second.
- Instagram allows 50 to 100 API posts a day per account. This uses 5.
- Reddit isn't a source: Reddit stopped accepting new API requests on Oct 31, 2026, and its RSS feeds end on Nov 13, 2026.
- The engine checks that a post's media is live on GitHub Pages before posting it, and retries on the next run if not.

## For developers
```
npm install
node test/run-tests.js            # full end-to-end test with local stand-ins for Claude, Instagram, GitHub (about 3 minutes)
node test/run-tests.js --quick    # renders 2 pages instead of 4
```
`engine/` contains the pipeline (`collect`, `generate`, `render`, `publish`, `metrics`, `refresh-tokens`, `site`). `shared/templates.js` is the meme renderer, shared by the headless renderer and the review app. `review/index.html` is the review app. Rendered media lives on the `media` branch, which is deployed to Pages.
