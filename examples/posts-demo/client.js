'use strict';

// A minimal API client. The base URL comes from the environment, which is
// the only hook mock-anything needs: no code changes, no SDK.
const BASE_URL =
  process.env.MOCK_ANYTHING_URL ||
  process.env.API_BASE_URL ||
  'https://jsonplaceholder.typicode.com';

async function getPost(id) {
  const res = await fetch(`${BASE_URL}/posts/${id}`);
  if (!res.ok) throw new Error(`getPost failed: ${res.status}`);
  return res.json();
}

async function firstPostTitle() {
  const res = await fetch(`${BASE_URL}/posts?_limit=1`);
  if (!res.ok) throw new Error(`firstPostTitle failed: ${res.status}`);
  const posts = await res.json();
  return posts[0].title;
}

async function createPost(title, body) {
  const res = await fetch(`${BASE_URL}/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, body, userId: 1 }),
  });
  if (!res.ok) throw new Error(`createPost failed: ${res.status}`);
  return res.json();
}

module.exports = { getPost, firstPostTitle, createPost };
