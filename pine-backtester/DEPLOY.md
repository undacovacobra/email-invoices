# Put Pine Backtester online (free)

This puts the app on [Vercel](https://vercel.com)'s free Hobby plan (for personal,
non-commercial use). You get your own web address that works from any computer or phone,
including market data, with nothing running on your PC. Every time new code is pushed
to GitHub, the site updates by itself.

## One-time setup (about 5 minutes)

1. Go to **vercel.com** and choose **Sign Up** → **Continue with GitHub**. Pick the
   **Hobby** (free) plan when asked.
2. On the dashboard click **Add New… → Project**.
3. Find **email-invoices** in the list and click **Import**. If it isn't listed, click
   **Adjust GitHub App Permissions** and give Vercel access to that repository.
4. On the "Configure Project" screen:
   * **Root Directory**: click **Edit** and choose **`pine-backtester`**. This matters:
     the repository holds another project too.
   * **Framework Preset**: **Other**.
   * Leave the build settings as they are.
5. Click **Deploy**. When it finishes you get an address like
   `https://email-invoices-xxxx.vercel.app`; open it. It goes straight to the app and
   loads MNQ data.

## Use the branch with the app

The app is on the branch **`claude/hopeful-cerf-7ldpix`**. Vercel's main address follows
the repository's default branch, so do one of these:

* **Simplest:** in the Vercel project open **Settings → Environments → Production**
  (on some accounts **Settings → Git → Production Branch**), set the branch to
  `claude/hopeful-cerf-7ldpix`, save, then go to **Deployments** and **Redeploy** the
  latest one.
* **Or** merge that branch into your default branch on GitHub.

Addresses for other branches ("preview deployments") ask you to log in to Vercel by
default. Your main address doesn't.

## Keep the 1-minute history growing (one-time, 1 minute)

The site ships with a saved archive of MNQ, NQ, MES and ES bars (`data/`), and a GitHub
Action adds the newest bars every Friday after the close. Yahoo only keeps 30 days of
1-minute bars, so this is what lets the 1-minute history keep growing. GitHub only runs
scheduled Actions from a repository's **default branch**, so make the app's branch the
default:

1. On GitHub open the **email-invoices** repository → **Settings** → **General**.
2. Under **Default branch** click the ⇄ (switch) button, choose
   **`claude/hopeful-cerf-7ldpix`**, then **Update** and confirm.
3. Open the **Actions** tab → **Update market data archive** → **Run workflow** once to
   check it works (it takes about a minute and commits any new bars).

Each update commits the new bars and Vercel redeploys the site by itself. Your browser
also keeps its own copy of every download, so history grows on your computer even
before this is set up.

## Good to know

* **Price data**: futures and stocks come from Yahoo Finance's free feed through the
  site's function (`api/history.js`), merged with the saved archive and your browser's
  copy. Micro contracts' daily history is extended with the full-size contract (same
  price), so MNQ daily goes back to 2000. Crypto comes straight from Binance (up to
  100,000 bars per timeframe, all of it for 1h and above).
* Yahoo sometimes rate-limits requests coming from cloud providers. If "Market data"
  shows an error, wait a minute and press **Load** again. CSV files and the sample data
  always work.
* Your script, inputs and settings are saved in your browser, so a different computer or
  browser starts fresh. Keep your scripts in a file.
* The free plan's limits (bandwidth, function runs) are far above what one person
  backtesting uses.
