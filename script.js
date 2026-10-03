import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  collection,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const firestore = getFirestore(firebaseApp);

function readStoredIds(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function renderIcons() {
  window.lucide?.createIcons();
}

const legacySavedItems = readStoredIds('frontpage-saved-items');

const state = {
  user: null,
  activeSection: 'feed',
  selectedCategory: 'All Items',
  selectedFeed: null,
  savedOnly: false,
  query: '',
  loadedData: null,
  articles: [],
  feedStatuses: [],
  fetchedAt: null,
  readItems: readStoredIds('frontpage-read-items'),
  savedBySection: {
    feed: readStoredIds('frontpage-saved-feed').size ? readStoredIds('frontpage-saved-feed') : legacySavedItems,
    digest: readStoredIds('frontpage-saved-digest'),
    discover: readStoredIds('frontpage-saved-discover'),
  },
  layout: 'list',
  visibleLimit: 50,
  sortOrder: 'newest',
};

const allCountEl = document.getElementById('allCount');
const unreadCountEl = document.getElementById('unreadCount');
const viewTitleEl = document.getElementById('viewTitle');
const feedListEl = document.getElementById('feedList');
const articleListEl = document.getElementById('articleList');
const searchInputEl = document.getElementById('searchInput');
const savedCountEl = document.getElementById('savedCount');
const healthStatusEl = document.getElementById('healthStatus');
const updatedAtEl = document.getElementById('updatedAt');
const viewPanelEl = document.getElementById('viewPanel');
const viewDescriptionEl = document.getElementById('viewDescription');
const sectionLabelEl = document.getElementById('articleSectionLabel');
const workspaceEl = document.querySelector('.workspace');
const articleDialogEl = document.getElementById('articleDialog');
const readerSourceEl = document.getElementById('readerSource');
const readerDateEl = document.getElementById('readerDate');
const readerTitleEl = document.getElementById('readerTitle');
const readerAuthorEl = document.getElementById('readerAuthor');
const readerBodyEl = document.getElementById('readerBody');
const readerSourceLinkEl = document.getElementById('readerSourceLink');
const accountDialogEl = document.getElementById('accountDialog');
const accountFormEl = document.getElementById('accountForm');
const accountEmailEl = document.getElementById('accountEmail');
const accountPasswordEl = document.getElementById('accountPassword');
const accountNameEl = document.getElementById('accountName');
const accountTitleEl = document.getElementById('accountTitle');
const accountDescriptionEl = document.getElementById('accountDescription');
const accountStatusEl = document.getElementById('accountStatus');
const accountUserEl = document.getElementById('accountUser');
const accountSubmitEl = document.getElementById('accountSubmit');
const accountModeButtonEl = document.getElementById('accountModeButton');
const displayNameFieldEl = document.getElementById('displayNameField');
const passwordFieldEl = document.getElementById('passwordField');
const resetPasswordButtonEl = document.getElementById('resetPasswordButton');
const signOutButtonEl = document.getElementById('signOutButton');
const openAccountButtonEl = document.getElementById('openAccountButton');
let accountMode = 'signin';
let snapshotSyncPromise = null;
const categoryColors = ['#4380d3', '#d85691', '#d69836', '#6766d4', '#8a58cc'];
const tagColors = {
  Frontend: ['#edf4ff', '#4779bb'],
  Design: ['#fff0f6', '#ad527a'],
  'Backend & DevOps': ['#fff5e4', '#a56d20'],
  'General Tech': ['#f0efff', '#6964b5'],
  'AI & ML': ['#f4edff', '#7952a8'],
};

function getRelativeTime(dateString) {
  if (!dateString || Number.isNaN(new Date(dateString).getTime())) return 'Date unavailable';

  const delta = Date.now() - new Date(dateString).getTime();
  const minutes = Math.max(1, Math.round(delta / 60000));

  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  return `${weeks}w ago`;
}

function categoryDocumentId(category) {
  return category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function feedDocumentId(feedUrl) {
  return btoa(feedUrl).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function writeFirestoreRecords(user, records) {
  const batchSize = 400;

  for (let start = 0; start < records.length; start += batchSize) {
    const batch = writeBatch(firestore);
    records.slice(start, start + batchSize).forEach((record) => {
      batch.set(doc(firestore, 'users', user.uid, ...record.path, record.id), record.data, { merge: true });
    });
    await batch.commit();
  }
}

async function persistFetchedData(user) {
  if (!user || !state.loadedData || !state.fetchedAt) return;
  if (snapshotSyncPromise) return snapshotSyncPromise;

  snapshotSyncPromise = (async () => {
    const syncRef = doc(firestore, 'users', user.uid, 'syncState', 'feeds');
    const previousSync = await getDoc(syncRef);
    if (previousSync.exists() && previousSync.data().fetchedAt === state.fetchedAt) return;

    const categoryRecords = state.loadedData.categories.map((category, index) => ({
      path: ['categories'],
      id: categoryDocumentId(category.name),
      data: { name: category.name, order: index, updatedAt: serverTimestamp() },
    }));
    const feedRecords = state.loadedData.categories.flatMap((category) => category.feeds.map((feed) => {
      const status = state.feedStatuses.find((item) => item.title === feed.title);
      return {
        path: ['feeds'],
        id: feedDocumentId(feed.feedUrl),
        data: {
          title: feed.title,
          feedUrl: feed.feedUrl,
          siteUrl: feed.siteUrl,
          description: feed.description || '',
          format: feed.format || 'unknown',
          category: category.name,
          health: status ? status.ok ? 'active' : 'error' : 'unknown',
          itemCount: status?.itemCount || 0,
          lastError: status?.error || null,
          lastFetchedAt: state.fetchedAt,
          updatedAt: serverTimestamp(),
        },
      };
    }));
    const articleRecords = state.articles.map((article) => ({
      path: ['categories', categoryDocumentId(article.category), 'articles'],
      id: article.id,
      data: {
        title: article.title,
        source: article.source,
        sourceUrl: article.sourceUrl,
        url: article.url,
        category: article.category,
        author: article.author || '',
        excerpt: article.excerpt || '',
        publishedAt: article.publishedAt || null,
        updatedAt: serverTimestamp(),
      },
    }));

    await setDoc(doc(firestore, 'users', user.uid), {
      email: user.email || '',
      displayName: user.displayName || '',
      updatedAt: serverTimestamp(),
    }, { merge: true });
    await writeFirestoreRecords(user, [...categoryRecords, ...feedRecords, ...articleRecords]);
    await setDoc(syncRef, {
      fetchedAt: state.fetchedAt,
      articleCount: state.articles.length,
      feedCount: feedRecords.length,
      updatedAt: serverTimestamp(),
    });
    accountStatusEl.textContent = `Synced ${state.articles.length.toLocaleString()} articles across ${categoryRecords.length} categories.`;
  })();

  try {
    await snapshotSyncPromise;
  } catch (error) {
    accountStatusEl.textContent = `Cloud sync failed: ${error.message}`;
  } finally {
    snapshotSyncPromise = null;
  }
}

async function persistReadItems(user, articles) {
  const records = articles.map((article) => ({
    path: ['readItems'],
    id: article.id,
    data: { readAt: serverTimestamp() },
  }));
  await writeFirestoreRecords(user, records);
}

async function loadUserReadingState(user) {
  const [savedSnapshot, readSnapshot] = await Promise.all([
    getDocs(collection(firestore, 'users', user.uid, 'savedItems')),
    getDocs(collection(firestore, 'users', user.uid, 'readItems')),
  ]);

  state.savedBySection = { feed: new Set(), digest: new Set(), discover: new Set() };
  savedSnapshot.forEach((savedDocument) => {
    const saved = savedDocument.data();
    if (state.savedBySection[saved.section] && saved.articleId) {
      state.savedBySection[saved.section].add(saved.articleId);
    }
  });
  state.readItems = new Set(readSnapshot.docs.map((readDocument) => readDocument.id));
}

function setAccountMode(mode) {
  accountMode = mode;
  const isSignedIn = Boolean(state.user);
  const isSignUp = mode === 'signup';
  const isReset = mode === 'reset';

  accountTitleEl.textContent = isSignedIn ? 'Your account' : isSignUp ? 'Create account' : isReset ? 'Reset password' : 'Sign in';
  accountDescriptionEl.textContent = isSignedIn
    ? 'Your feeds and reading activity sync to your account.'
    : isReset
      ? 'We’ll email you a link to reset your password.'
      : 'Sign in to sync your feeds and reading data across devices.';
  displayNameFieldEl.hidden = !isSignUp || isSignedIn;
  accountNameEl.required = isSignUp && !isSignedIn;
  passwordFieldEl.hidden = isReset || isSignedIn;
  accountPasswordEl.required = !isReset && !isSignedIn;
  accountFormEl.hidden = isSignedIn;
  accountUserEl.hidden = !isSignedIn;
  accountUserEl.textContent = state.user?.email || '';
  accountSubmitEl.textContent = isSignUp ? 'Create account' : isReset ? 'Send reset link' : 'Sign in';
  accountModeButtonEl.hidden = isSignedIn;
  accountModeButtonEl.textContent = isSignUp || isReset ? 'Back to sign in' : 'Create an account';
  resetPasswordButtonEl.hidden = isSignedIn || isSignUp || isReset;
  signOutButtonEl.hidden = !isSignedIn;
}

function updateAccountButton(user) {
  if (!user) {
    openAccountButtonEl.textContent = 'G';
    openAccountButtonEl.setAttribute('aria-label', 'Sign in to your account');
    return;
  }

  const identity = user.displayName || user.email || 'User';
  const initials = identity.split(/\s+|@/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  openAccountButtonEl.textContent = initials || 'U';
  openAccountButtonEl.setAttribute('aria-label', `Account: ${user.email || identity}`);
}

onAuthStateChanged(auth, async (user) => {
  state.user = user;
  updateAccountButton(user);

  if (user) {
    setAccountMode('signin');
    try {
      await loadUserReadingState(user);
      await persistFetchedData(user);
    } catch (error) {
      accountStatusEl.textContent = `Could not load your account data: ${error.message}`;
    }
  } else {
    state.readItems = readStoredIds('frontpage-read-items');
    state.savedBySection = {
      feed: readStoredIds('frontpage-saved-feed').size ? readStoredIds('frontpage-saved-feed') : legacySavedItems,
      digest: readStoredIds('frontpage-saved-digest'),
      discover: readStoredIds('frontpage-saved-discover'),
    };
    setAccountMode('signin');
  }

  if (state.loadedData) render();
});

function makeArticleList(data) {
  return data.map((article) => ({
    ...article,
    unread: !state.readItems.has(article.id),
  }));
}

function getSectionItems() {
  const articles = makeArticleList(state.articles);
  if (state.savedOnly) return articles.filter((article) => state.savedBySection[state.activeSection].has(article.id));
  if (state.activeSection === 'feed') return articles;

  const groupLimit = state.activeSection === 'digest' ? 3 : 4;
  const groupKey = state.activeSection === 'digest' ? 'category' : 'source';
  const groupCounts = new Map();
  const selected = [];

  for (const article of articles) {
    if (state.activeSection === 'digest' && !article.unread) continue;
    const count = groupCounts.get(article[groupKey]) || 0;
    if (count >= groupLimit) continue;
    groupCounts.set(article[groupKey], count + 1);
    selected.push(article);
  }

  return selected;
}

function getFilteredArticles() {
  const articles = getSectionItems();

  return articles.filter((article) => {
    const matchesCategory = state.selectedCategory === 'All Items' || article.category === state.selectedCategory;
    const matchesFeed = !state.selectedFeed || article.source === state.selectedFeed;

    const haystack = `${article.title} ${article.source} ${article.excerpt}`.toLowerCase();
    const matchesQuery = haystack.includes(state.query.toLowerCase());

    return matchesCategory && matchesFeed && matchesQuery;
  }).sort((first, second) => {
    const firstDate = first.publishedAt ? Date.parse(first.publishedAt) : 0;
    const secondDate = second.publishedAt ? Date.parse(second.publishedAt) : 0;
    return state.sortOrder === 'newest' ? secondDate - firstDate : firstDate - secondDate;
  });
}

function renderFeedList() {
  if (!state.loadedData) {
    feedListEl.replaceChildren();
    return;
  }

  const articles = makeArticleList(state.articles);

  feedListEl.innerHTML = state.loadedData.categories
    .map((category, categoryIndex) => {
      const categoryUnread = articles.filter((article) => article.category === category.name && article.unread).length;
      const categoryActive = state.selectedCategory === category.name && !state.selectedFeed ? 'active' : '';
      const feeds = category.feeds.map((feed, feedIndex) => {
        const unreadCount = articles.filter((article) => article.source === feed.title && article.unread).length;
        const feedActive = state.selectedFeed === feed.title ? 'active' : '';
        const initial = feed.title.charAt(0).toUpperCase();
        const hue = (categoryIndex * 53 + feedIndex * 31) % 360;

        return `
          <button class="feed-link ${feedActive}" type="button" data-feed="${feed.title}" data-category="${category.name}">
            <span class="feed-favicon" style="--feed-color: hsl(${hue} 58% 48%)">${initial}</span>
            <span class="feed-name">${feed.title}</span>
            <span class="feed-count">${unreadCount || ''}</span>
          </button>
        `;
      }).join('');

      return `
        <div class="category-group">
          <button class="category-link ${categoryActive}" type="button" data-category="${category.name}" style="--category-color: ${categoryColors[categoryIndex % categoryColors.length]}">
            <span class="category-dot"></span>
            <span>${category.name}</span>
            <span class="category-count">${categoryUnread}</span>
          </button>
          ${feeds}
        </div>
      `;
    })
    .join('');

  feedListEl.querySelectorAll('.category-link').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeSection = 'feed';
      state.savedOnly = false;
      state.selectedCategory = button.dataset.category;
      state.selectedFeed = null;
      render();
    });
  });

  feedListEl.querySelectorAll('.feed-link').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeSection = 'feed';
      state.savedOnly = false;
      state.selectedCategory = button.dataset.category;
      state.selectedFeed = button.dataset.feed;
      render();
    });
  });
}

function renderArticles() {
  const filteredArticles = getFilteredArticles();
  const visibleArticles = filteredArticles.slice(0, state.visibleLimit);

  if (filteredArticles.length === 0) {
    const failedFeeds = state.feedStatuses.filter((feed) => !feed.ok);
    const emptyHeading = state.savedOnly
      ? `No items saved from ${state.activeSection === 'feed' ? 'Feeds' : state.activeSection === 'digest' ? 'Digest' : 'Discover'} yet.`
      : state.query ? 'No articles match your search.' : 'No feed items to show.';
    const message = state.savedOnly
      ? 'Use the bookmark icon on an item to save it here.'
      : failedFeeds.length === state.feedStatuses.length && failedFeeds.length > 0
        ? 'Could not retrieve items from the selected feeds.'
        : 'Try another keyword or switch to a different category.';
    articleListEl.innerHTML = `
      <div class="empty-state">
        <h3>${escapeHtml(emptyHeading)}</h3>
        <p>${escapeHtml(message)}</p>
      </div>
    `;
    return;
  }

  articleListEl.className = `article-list ${state.layout}-view`;
  articleListEl.innerHTML = visibleArticles.map((article) => {
    const [tagBackground, tagColor] = tagColors[article.category] || ['#edf4ff', '#4779bb'];
    const sourceHue = [...article.source].reduce((value, character) => value + character.charCodeAt(0), 0) % 360;
    const isSaved = state.savedBySection[state.activeSection].has(article.id);

    return `
      <article class="article-card ${article.unread ? 'unread' : 'read'}" data-article-id="${escapeHtml(article.id)}">
        <button class="bookmark-button ${isSaved ? 'is-bookmarked' : ''}" type="button" data-bookmark-id="${escapeHtml(article.id)}" aria-label="${isSaved ? 'Remove from Saved' : 'Save item'}" aria-pressed="${isSaved}">
          <i data-lucide="bookmark" aria-hidden="true"></i>
        </button>
        <div class="article-main">
          <div class="article-meta">
            <span class="article-source" data-initial="${escapeHtml(article.source.charAt(0).toUpperCase())}" style="--source-color: hsl(${sourceHue} 58% 48%)">${escapeHtml(article.source)}</span>
            <span>·</span>
            <time class="article-time" ${article.publishedAt ? `datetime="${escapeHtml(article.publishedAt)}"` : ''}>${escapeHtml(getRelativeTime(article.publishedAt))}</time>
          </div>
          <h3>${escapeHtml(article.title)}</h3>
          <p>${escapeHtml(article.excerpt)}</p>
          <span class="article-category" style="--tag-bg: ${tagBackground}; --tag-color: ${tagColor}">${escapeHtml(article.category)}</span>
          <a class="article-link" href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">Open ${escapeHtml(article.source)}</a>
        </div>
      </article>
    `;
  }).join('');

  if (filteredArticles.length > visibleArticles.length) {
    articleListEl.insertAdjacentHTML('beforeend', `
      <button class="load-more-button" id="loadMoreButton" type="button">
        Load more <span>(${filteredArticles.length - visibleArticles.length} remaining)</span>
      </button>
    `);
  }
}

function renderOverview() {
  const articles = makeArticleList(state.articles);
  const unreadArticles = articles.filter((article) => article.unread);
  const activeSavedItems = state.savedBySection[state.activeSection];
  const visibleUnread = getFilteredArticles().filter((article) => article.unread).length;

  allCountEl.textContent = unreadArticles.length;
  unreadCountEl.textContent = visibleUnread;
  savedCountEl.textContent = activeSavedItems.size;
  document.querySelectorAll('[data-section-count]').forEach((count) => {
    count.textContent = state.savedBySection[count.dataset.sectionCount].size;
  });

  const failedFeeds = state.feedStatuses.filter((feed) => !feed.ok);
  healthStatusEl.innerHTML = failedFeeds.length
    ? `<i class="health-check" data-lucide="circle-alert" aria-hidden="true"></i> ${failedFeeds.length} ${failedFeeds.length === 1 ? 'feed' : 'feeds'} unavailable`
    : '<i class="health-check" data-lucide="circle-check" aria-hidden="true"></i> All feeds healthy';
  updatedAtEl.textContent = state.fetchedAt
    ? `Updated ${getRelativeTime(state.fetchedAt)}`
    : 'Waiting for feed data';

  const sectionLabels = { feed: 'Feed', digest: 'Digest', discover: 'Discover' };
  const sectionNames = { feed: 'Feeds', digest: 'Digest', discover: 'Discover' };
  let selectedLabel = state.activeSection === 'feed'
    ? (state.selectedFeed || (state.selectedCategory === 'All Items' ? 'All Items' : state.selectedCategory))
    : state.activeSection === 'digest' ? 'Daily Digest' : 'Discover';

  if (state.savedOnly) selectedLabel = `Saved ${sectionNames[state.activeSection]}`;
  viewTitleEl.textContent = selectedLabel;
  viewDescriptionEl.hidden = state.activeSection === 'feed' && !state.savedOnly;
  viewDescriptionEl.textContent = state.savedOnly
    ? `Items saved from ${sectionLabels[state.activeSection]}.`
    : state.activeSection === 'digest'
      ? 'A balanced brief of the latest unread stories across your categories.'
      : state.activeSection === 'discover'
        ? 'Fresh picks from across your subscribed sources, balanced by publisher.'
        : '';
  sectionLabelEl.textContent = state.savedOnly
    ? 'Saved items'
    : state.activeSection === 'digest' ? 'Today’s digest' : state.activeSection === 'discover' ? 'Fresh discoveries' : 'Today';
  workspaceEl.dataset.section = state.activeSection;

  document.querySelectorAll('.nav-item[data-category]').forEach((button) => {
    const isSavedNav = button.dataset.category === 'Saved';
    button.classList.toggle('active', isSavedNav ? state.savedOnly : !state.savedOnly && button.dataset.category === state.selectedCategory);
  });
  document.querySelectorAll('.top-nav-link').forEach((button) => {
    const isActive = button.dataset.view.toLowerCase() === state.activeSection;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });
}

function render() {
  renderOverview();
  renderFeedList();
  renderArticles();
  renderIcons();
}

async function openArticle(articleId) {
  const article = state.articles.find((item) => item.id === articleId);
  if (!article) return;

  state.readItems.add(articleId);
  if (state.user) {
    setDoc(doc(firestore, 'users', state.user.uid, 'readItems', articleId), { readAt: serverTimestamp() })
      .catch((error) => { accountStatusEl.textContent = `Could not save reading state: ${error.message}`; });
  } else {
    localStorage.setItem('frontpage-read-items', JSON.stringify([...state.readItems]));
  }
  render();

  readerSourceEl.textContent = article.source;
  readerDateEl.textContent = getRelativeTime(article.publishedAt);
  readerTitleEl.textContent = article.title;
  readerAuthorEl.textContent = article.author || '';
  readerAuthorEl.hidden = !article.author;
  readerBodyEl.textContent = article.excerpt || 'Full text is not available in this feed.';
  readerSourceLinkEl.href = article.url;
  articleDialogEl.showModal();
  renderIcons();

  try {
    const response = await fetch(`/api/articles/${encodeURIComponent(articleId)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Full text unavailable');

    const detail = result.article;
    readerBodyEl.textContent = detail.contentText || detail.excerpt || 'Full text is not available in this feed.';
    readerAuthorEl.textContent = detail.author || '';
    readerAuthorEl.hidden = !detail.author;
    if (state.user && detail.contentText) {
      setDoc(doc(firestore, 'users', state.user.uid, 'categories', categoryDocumentId(detail.category), 'articles', articleId), {
        contentText: detail.contentText,
        updatedAt: serverTimestamp(),
      }, { merge: true }).catch((error) => {
        accountStatusEl.textContent = `Could not save article text: ${error.message}`;
      });
    }
  } catch {
    readerBodyEl.textContent = article.excerpt || 'Full text is not available in this feed. Open the original article for the complete story.';
  }
}

async function loadLiveArticles(forceRefresh = false) {
  const url = forceRefresh ? '/api/articles?refresh=1' : '/api/articles';
  const response = await fetch(url);
  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || 'Unable to load live feed items');
  }

  state.articles = result.articles || [];
  state.feedStatuses = result.feeds || [];
  state.fetchedAt = result.fetchedAt || null;
  render();
  if (state.user) void persistFetchedData(state.user);
}

async function init() {
  try {
    const response = await fetch('./data/sample-feeds.json');
    if (!response.ok) throw new Error('Unable to load feed data');

    state.loadedData = await response.json();
    await loadLiveArticles();
  } catch (error) {
    healthStatusEl.innerHTML = '<i class="health-check" data-lucide="circle-alert" aria-hidden="true"></i> Feed server unavailable';
    articleListEl.innerHTML = `
      <div class="empty-state">
        <h3>Unable to load live feeds.</h3>
        <p>${escapeHtml(error.message)} Start the app with <code>npm start</code> and open <code>http://localhost:3000</code>.</p>
      </div>
    `;
    renderIcons();
  }
}

openAccountButtonEl.addEventListener('click', () => {
  accountStatusEl.textContent = '';
  setAccountMode('signin');
  accountDialogEl.showModal();
  renderIcons();
});

document.getElementById('closeAccountButton').addEventListener('click', () => accountDialogEl.close());
accountDialogEl.addEventListener('click', (event) => {
  if (event.target === accountDialogEl) accountDialogEl.close();
});

accountModeButtonEl.addEventListener('click', () => {
  setAccountMode(accountMode === 'signup' || accountMode === 'reset' ? 'signin' : 'signup');
  accountStatusEl.textContent = '';
});

resetPasswordButtonEl.addEventListener('click', () => {
  setAccountMode('reset');
  accountStatusEl.textContent = '';
});

accountFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  accountSubmitEl.disabled = true;
  accountStatusEl.textContent = '';
  const email = accountEmailEl.value.trim();

  try {
    if (accountMode === 'reset') {
      await sendPasswordResetEmail(auth, email);
      accountStatusEl.textContent = 'Password reset email sent. Check your inbox.';
      return;
    }

    if (accountMode === 'signup') {
      const credential = await createUserWithEmailAndPassword(auth, email, accountPasswordEl.value);
      await updateProfile(credential.user, { displayName: accountNameEl.value.trim() });
    } else {
      await signInWithEmailAndPassword(auth, email, accountPasswordEl.value);
    }

    accountDialogEl.close();
  } catch (error) {
    const messages = {
      'auth/email-already-in-use': 'An account already exists for this email. Sign in instead.',
      'auth/invalid-credential': 'Email or password is incorrect.',
      'auth/weak-password': 'Use a password with at least 8 characters.',
      'auth/operation-not-allowed': 'Enable Email/Password sign-in in Firebase Authentication settings.',
      'auth/too-many-requests': 'Too many attempts. Wait a little and try again.',
    };
    accountStatusEl.textContent = messages[error.code] || error.message;
  } finally {
    accountSubmitEl.disabled = false;
  }
});

signOutButtonEl.addEventListener('click', async () => {
  try {
    await signOut(auth);
    accountStatusEl.textContent = '';
    accountDialogEl.close();
  } catch (error) {
    accountStatusEl.textContent = `Could not sign out: ${error.message}`;
  }
});

searchInputEl.addEventListener('input', (event) => {
  state.query = event.target.value.trim();
  state.visibleLimit = 50;
  render();
});

document.querySelectorAll('.nav-item[data-category]').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.category === 'All Items') state.activeSection = 'feed';
    state.savedOnly = button.dataset.category === 'Saved';
    state.selectedCategory = 'All Items';
    state.selectedFeed = null;
    state.visibleLimit = 50;
    render();
  });
});

document.querySelectorAll('.top-nav-link').forEach((button) => {
  button.addEventListener('click', () => {
    state.activeSection = button.dataset.view.toLowerCase();
    state.savedOnly = false;
    state.selectedCategory = 'All Items';
    state.selectedFeed = null;
    state.visibleLimit = 50;
    state.layout = 'list';
    document.querySelectorAll('.view-button').forEach((viewButton, index) => viewButton.classList.toggle('active', index === 0));
    render();
  });
});

document.getElementById('markReadButton').addEventListener('click', () => {
  const articles = getFilteredArticles();
  articles.forEach((article) => state.readItems.add(article.id));
  if (state.user) {
    persistReadItems(state.user, articles)
      .catch((error) => { accountStatusEl.textContent = `Could not save reading state: ${error.message}`; });
  } else {
    localStorage.setItem('frontpage-read-items', JSON.stringify([...state.readItems]));
  }
  render();
});

document.getElementById('refreshButton').addEventListener('click', async (event) => {
  const refreshButton = event.currentTarget;
  refreshButton.classList.add('is-refreshing');
  refreshButton.disabled = true;
  updatedAtEl.textContent = 'Refreshing feeds...';
  try {
    await loadLiveArticles(true);
  } catch (error) {
    articleListEl.innerHTML = `<div class="empty-state"><h3>Feed refresh failed.</h3><p>${escapeHtml(error.message)}</p></div>`;
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove('is-refreshing');
  }
});

articleListEl.addEventListener('click', (event) => {
  if (event.target.closest('#loadMoreButton')) {
    state.visibleLimit += 50;
    renderArticles();
    renderIcons();
    return;
  }
  const bookmarkButton = event.target.closest('[data-bookmark-id]');
  if (bookmarkButton) {
    event.preventDefault();
    event.stopPropagation();
    const savedItems = state.savedBySection[state.activeSection];
    if (savedItems.has(bookmarkButton.dataset.bookmarkId)) savedItems.delete(bookmarkButton.dataset.bookmarkId);
    else savedItems.add(bookmarkButton.dataset.bookmarkId);
    const articleId = bookmarkButton.dataset.bookmarkId;
    if (state.user) {
      const bookmarkRef = doc(firestore, 'users', state.user.uid, 'savedItems', `${state.activeSection}_${articleId}`);
      const cloudWrite = savedItems.has(articleId)
        ? setDoc(bookmarkRef, { section: state.activeSection, articleId, savedAt: serverTimestamp() })
        : deleteDoc(bookmarkRef);
      cloudWrite.catch((error) => {
        if (savedItems.has(articleId)) savedItems.delete(articleId);
        else savedItems.add(articleId);
        accountStatusEl.textContent = `Could not save bookmark: ${error.message}`;
        render();
      });
    } else {
      localStorage.setItem(`frontpage-saved-${state.activeSection}`, JSON.stringify([...savedItems]));
    }
    render();
    return;
  }
  if (event.target.closest('a')) return;
  const article = event.target.closest('[data-article-id]');
  if (!article) return;
  openArticle(article.dataset.articleId);
});

document.getElementById('closeReaderButton').addEventListener('click', () => articleDialogEl.close());
articleDialogEl.addEventListener('click', (event) => {
  if (event.target === articleDialogEl) articleDialogEl.close();
});

document.querySelectorAll('.view-button').forEach((button, index) => {
  button.addEventListener('click', () => {
    state.layout = ['list', 'grid', 'compact'][index];
    document.querySelectorAll('.view-button').forEach((viewButton) => viewButton.classList.toggle('active', viewButton === button));
    renderArticles();
    renderIcons();
  });
});

document.getElementById('sortButton').addEventListener('click', (event) => {
  state.sortOrder = state.sortOrder === 'newest' ? 'oldest' : 'newest';
  event.currentTarget.setAttribute('aria-label', `Sort ${state.sortOrder} first`);
  event.currentTarget.innerHTML = state.sortOrder === 'newest'
    ? '<i data-lucide="arrow-down-wide-narrow" aria-hidden="true"></i> Newest'
    : '<i data-lucide="arrow-up-narrow-wide" aria-hidden="true"></i> Oldest';
  renderArticles();
  renderIcons();
});

init();
