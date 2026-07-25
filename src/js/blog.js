(function () {
  "use strict";

  const listView = document.getElementById("blog-list-view");
  const postView = document.getElementById("blog-post-view");
  if (!listView || !postView) return;

  const loadingEl = document.getElementById("blog-loading");
  const emptyEl = document.getElementById("blog-empty");
  const errorEl = document.getElementById("blog-error");
  const listEl = document.getElementById("blog-list");

  const postArticle = document.getElementById("blog-post");
  const postTitleEl = document.getElementById("blog-post-title");
  const postDateEl = document.getElementById("blog-post-date");
  const postBodyEl = document.getElementById("blog-post-body");
  const postErrorEl = document.getElementById("blog-post-error");
  const backLink = document.getElementById("blog-back-link");

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString("en-US", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    } catch {
      return iso;
    }
  }

  function slugFromLocation() {
    return new URLSearchParams(window.location.search).get("post");
  }

  function showList() {
    postView.hidden = true;
    listView.hidden = false;
  }

  function showPost() {
    listView.hidden = true;
    postView.hidden = false;
  }

  function isPlainClick(e) {
    return !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);
  }

  async function renderList() {
    showList();
    loadingEl.hidden = false;
    emptyEl.hidden = true;
    errorEl.hidden = true;
    listEl.hidden = true;
    listEl.innerHTML = "";

    try {
      const res = await fetch("/api/posts");
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      const posts = data.posts || [];

      loadingEl.hidden = true;

      if (posts.length === 0) {
        emptyEl.hidden = false;
        return;
      }

      posts.forEach((post) => {
        const li = document.createElement("li");
        li.className = "blog-list-item";

        const a = document.createElement("a");
        a.href = `/blog/?post=${encodeURIComponent(post.slug)}`;
        a.className = "blog-list-title";
        a.textContent = post.title;
        a.addEventListener("click", (e) => {
          if (!isPlainClick(e)) return;
          e.preventDefault();
          navigateToPost(post.slug);
        });

        const time = document.createElement("time");
        time.className = "blog-list-date";
        time.dateTime = post.created_at;
        time.textContent = formatDate(post.created_at);

        const excerpt = document.createElement("p");
        excerpt.className = "blog-list-excerpt";
        excerpt.textContent = post.excerpt || "";

        li.appendChild(a);
        li.appendChild(time);
        li.appendChild(excerpt);
        listEl.appendChild(li);
      });

      listEl.hidden = false;
    } catch (err) {
      loadingEl.hidden = true;
      errorEl.hidden = false;
    }
  }

  async function renderPost(slug) {
    showPost();
    postErrorEl.hidden = true;
    postArticle.hidden = false;
    postTitleEl.textContent = "Loading...";
    postDateEl.textContent = "";
    postBodyEl.innerHTML = "";

    try {
      const res = await fetch(`/api/posts?slug=${encodeURIComponent(slug)}`);
      if (res.status === 404) {
        postArticle.hidden = true;
        postErrorEl.hidden = false;
        return;
      }
      if (!res.ok) throw new Error("bad response");

      const data = await res.json();
      const post = data.post;

      postTitleEl.textContent = post.title;
      postDateEl.dateTime = post.created_at;
      postDateEl.textContent = formatDate(post.created_at);
      postBodyEl.innerHTML = renderMarkdown(post.body_md);
      document.title = `${post.title} · Blog · Victory Sparkle Co.`;
    } catch (err) {
      postArticle.hidden = true;
      postErrorEl.hidden = false;
    }
  }

  // Always sanitize before inserting, even though the author is trusted —
  // defense in depth. Falls back to plain text if marked/DOMPurify failed
  // to load from the CDN (see onerror handlers in blog.njk).
  function renderMarkdown(md) {
    if (window.__libLoadFailed || !window.marked || !window.DOMPurify) {
      const p = document.createElement("p");
      p.textContent = md;
      return p.outerHTML;
    }
    const html = window.marked.parse(md);
    return window.DOMPurify.sanitize(html);
  }

  function navigateToPost(slug) {
    history.pushState({ post: slug }, "", `/blog/?post=${encodeURIComponent(slug)}`);
    renderPost(slug);
  }

  function navigateToList() {
    history.pushState({}, "", "/blog/");
    renderList();
  }

  if (backLink) {
    backLink.addEventListener("click", (e) => {
      if (!isPlainClick(e)) return;
      e.preventDefault();
      navigateToList();
    });
  }

  window.addEventListener("popstate", () => {
    const slug = slugFromLocation();
    if (slug) {
      renderPost(slug);
    } else {
      renderList();
    }
  });

  const initialSlug = slugFromLocation();
  if (initialSlug) {
    renderPost(initialSlug);
  } else {
    renderList();
  }
})();
