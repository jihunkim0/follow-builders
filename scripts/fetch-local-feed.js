#!/usr/bin/env node

// ============================================================================
// Follow Builders — Local Feed Generator
// ============================================================================
// Fetches tweets for a user's personal list of X accounts.
// Reads X_BEARER_TOKEN from ~/.follow-builders/.env
// Reads sources from ~/.follow-builders/local-sources.json
// Outputs to /tmp/feed-x-local.json
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const USER_DIR = join(homedir(), '.follow-builders');
const ENV_PATH = join(USER_DIR, '.env');
const SOURCES_PATH = join(USER_DIR, 'local-sources.json');
const OUTPUT_PATH = '/tmp/feed-x-local.json';

const X_API_BASE = 'https://api.x.com/2';
const TWEET_LOOKBACK_HOURS = 24;
const MAX_TWEETS_PER_USER = 3;

// Minimal .env parser
async function loadEnv() {
  if (!existsSync(ENV_PATH)) return {};
  const content = await readFile(ENV_PATH, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        env[match[1].trim()] = match[2].trim().replace(/^['"](.*)['"]$/, '$1');
      }
    }
  }
  return env;
}

async function loadSources() {
  if (!existsSync(SOURCES_PATH)) return null;
  try {
    return JSON.parse(await readFile(SOURCES_PATH, 'utf-8'));
  } catch (err) {
    return null;
  }
}

async function fetchXContent(xAccounts, bearerToken, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  const handles = xAccounts.map(a => a.handle);
  let userMap = {};

  // Batch lookup all user IDs
  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const res = await fetch(
        `${X_API_BASE}/users/by?usernames=${batch.join(',')}&user.fields=name,description`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        errors.push(`Local X API: User lookup failed: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      for (const user of (data.data || [])) {
        userMap[user.username.toLowerCase()] = {
          id: user.id,
          name: user.name,
          description: user.description || ''
        };
      }
    } catch (err) {
      errors.push(`Local X API: User lookup error: ${err.message}`);
    }
  }

  // Fetch recent tweets per user
  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) continue;

    try {
      const res = await fetch(
        `${X_API_BASE}/users/${userData.id}/tweets?` +
        `max_results=5` +
        `&tweet.fields=created_at,public_metrics,referenced_tweets` +
        `&exclude=retweets,replies` +
        `&start_time=${cutoff.toISOString()}`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        errors.push(`Local X API: Failed to fetch tweets for @${account.handle}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const allTweets = data.data || [];

      const newTweets = [];
      for (const t of allTweets) {
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;

        newTweets.push({
          id: t.id,
          text: t.text,
          createdAt: t.created_at,
          url: `https://x.com/${account.handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          isQuote: t.referenced_tweets?.some(r => r.type === 'quoted') || false,
          quotedTweetId: t.referenced_tweets?.find(r => r.type === 'quoted')?.id || null
        });
      }

      if (newTweets.length === 0) continue;

      results.push({
        source: 'x_local',
        name: account.name,
        handle: account.handle,
        bio: userData.description,
        tweets: newTweets
      });

      await new Promise(r => setTimeout(r, 200)); // Buffer to avoid rate limits
    } catch (err) {
      errors.push(`Local X API: Error fetching @${account.handle}: ${err.message}`);
    }
  }

  return results;
}

async function main() {
  const env = await loadEnv();
  const bearerToken = process.env.X_BEARER_TOKEN || env.X_BEARER_TOKEN;
  
  if (!bearerToken) {
    process.exit(0);
  }

  const sources = await loadSources();
  if (!sources || !sources.x_accounts || sources.x_accounts.length === 0) {
    process.exit(0);
  }

  const errors = [];
  const xContent = await fetchXContent(sources.x_accounts, bearerToken, errors);

  const localFeed = {
    generatedAt: new Date().toISOString(),
    lookbackHours: TWEET_LOOKBACK_HOURS,
    x: xContent,
    stats: { localBuilders: xContent.length },
    errors: errors.length > 0 ? errors : undefined
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(localFeed, null, 2));
}

main().catch(err => {
  process.exit(1);
});
