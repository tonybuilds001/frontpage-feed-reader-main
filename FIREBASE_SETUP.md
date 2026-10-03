# Firebase Setup

The app uses Firebase Authentication with email/password and Cloud Firestore. The browser configuration is in `firebase-config.js`; Firebase web config is public by design, so access must be protected by Authentication and Firestore Rules.

## Enable Firebase Services

1. Open the Firebase Console and select the `frontpage-feed-reader-main` project.
2. In **Authentication > Sign-in method**, enable **Email/Password**.
3. In **Firestore Database**, create a database.
4. In **Firestore Database > Rules**, publish the rules from `firestore.rules`.
5. In **Authentication > Settings > Authorized domains**, make sure `localhost` and your deployed domain are listed.

If sign-up works but cloud sync reports a permission/database error, check that Firestore exists and its rules have been published.

## Stored Data

All documents are private to their owning Firebase user (`users/{uid}`):

- `categories/{categoryId}` stores category labels and ordering.
- `feeds/{feedId}` stores feed subscriptions and their categories.
- `categories/{categoryId}/articles/{articleId}` stores fetched items by category. Full article text is added when the item is opened and that text is available in the feed.
- `savedItems/{section_articleId}` stores bookmarks independently for Feed, Digest, and Discover.
- `readItems/{articleId}` stores read state.
- `syncState/feeds` records the last feed snapshot synced for that user.

Fetched articles are written in batches of up to 400 documents. Unchanged cached snapshots are not written again.

## Run Locally

From the project folder, run `npm install`, then `npm start`, and open `http://localhost:3000`. If port 3000 is already occupied, set a different `PORT` before starting the server.
