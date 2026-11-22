'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getPost, firstPostTitle, createPost } = require('./client');

test('getPost returns the post with its author', async () => {
  const post = await getPost(1);
  assert.equal(post.id, 1);
  assert.equal(post.userId, 1);
  assert.ok(post.title.length > 0);
});

test('firstPostTitle returns a non-empty title', async () => {
  const title = await firstPostTitle();
  assert.ok(typeof title === 'string' && title.length > 0);
});

test('createPost sends the draft and gets an id back', async () => {
  const created = await createPost('draft title', 'draft body');
  assert.equal(created.title, 'draft title');
  assert.ok(created.id > 0);
});
