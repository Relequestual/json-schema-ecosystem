import { Octokit } from 'octokit';
import cheerio from 'cheerio';
import fs from 'fs';
import { getInput } from './setup.js';

const WAYBACK_API_URL = 'http://archive.org/wayback/available';
const CSV_FILE_NAME = `initialTopicRepoData-${Date.now()}.csv`;

async function fetchRepoCreationDate(octokit, owner, repo) {
  console.log(`Fetching creation date for repository: ${owner}/${repo}`);
  const response = await octokit.request('GET /repos/{owner}/{repo}', {
    owner,
    repo,
  });
  return response.data.created_at;
}

async function fetchLatestReleaseDate(octokit, owner, repo) {
  console.log(`Fetching latest release date for repository: ${owner}/${repo}`);
  const response = await octokit.request('GET /repos/{owner}/{repo}/releases', {
    owner,
    repo,
    per_page: 1,
  });
  const lastPageUrl = response.headers.link?.match(
    /<([^>]+)>;\s*rel="last"/,
  )?.[1];

  if (!lastPageUrl) {
    return response.data.length > 0 ? response.data[0].created_at : null;
  }

  const lastPageResponse = await octokit.request(lastPageUrl);
  return lastPageResponse.data.length > 0
    ? lastPageResponse.data[0].created_at
    : null;
}

async function fetchWaybackSnapshot(url, timestamp) {
  console.log(
    `Fetching Wayback Machine snapshot for URL: ${url} at timestamp: ${timestamp}`,
  );
  console.log(`${WAYBACK_API_URL}?url=${url}&timestamp=${timestamp}`);
  const response = await fetch(
    `${WAYBACK_API_URL}?url=${url}&timestamp=${timestamp}`,
  );
  const data = await response.json();
  return data.archived_snapshots;
}

async function checkTopicInPage(url, topic) {
  console.log(`Checking if topic "${topic}" exists in page: ${url}`);
  const response = await fetch(url);
  const html = await response.text();
  const $ = cheerio.load(html);
  return $(`a.topic-tag-link:contains('${topic}')`).length > 0;
}

function appendToCSV(data) {
  console.log(`Appending data to CSV: ${data}`);
  const csvLine = `${data.join(',')}\n`;
  fs.appendFileSync(CSV_FILE_NAME, csvLine, 'utf8');
}

async function processRepository(octokit, owner, repo, topic) {
  console.log(`Processing repository: ${owner}/${repo}`);
  const githubRepoURL = `https://github.com/${owner}/${repo}`;

  const creationDate = await fetchRepoCreationDate(octokit, owner, repo);
  const latestReleaseDate = await fetchLatestReleaseDate(octokit, owner, repo);

  for (const [dateType, isoDate] of [
    ['creation', creationDate],
    ['release', latestReleaseDate],
  ]) {
    if (isoDate) {
      console.log(`Processing ${dateType} date: ${isoDate}`);
      const date = new Date(isoDate);
      const datestamp = date.getTime();
      const archivedSnapshots = await fetchWaybackSnapshot(
        githubRepoURL,
        datestamp,
      );
      if (Object.keys(archivedSnapshots).length === 0) {
        console.log(`Unable to find archive for ${githubRepoURL}`);
      } else {
        const archiveUrl = archivedSnapshots.closest.url;
        if (archiveUrl) {
          const topicExists = await checkTopicInPage(archiveUrl, topic);
          const data = [
            `${owner}/${repo}`,
            dateType,
            datestamp,
            archiveUrl,
            topicExists,
          ];
          appendToCSV(data);
        } else {
          console.error(
            `Couldn't get closest archive URL given response from ${githubRepoURL}`,
          );
        }
      }
    }
  }
}

async function main(token, topic, numRepos) {
  const octokit = new Octokit({ auth: token });

  if (!fs.existsSync(CSV_FILE_NAME)) {
    fs.writeFileSync(
      CSV_FILE_NAME,
      'repo,date_type,datestamp,snapshot_datestamp,topic_present\n',
      'utf8',
    );
  }

  const iterator = octokit.paginate.iterator(octokit.rest.search.repos, {
    q: `topic:${topic}`,
    per_page: 100,
  });
  console.log(iterator);

  let processedRepos = 0;

  for await (const iteration of iterator) {
    const data = iteration.data;
    for (const repo of data) {
      if (numRepos !== -1 && processedRepos >= numRepos) break;
      await processRepository(octokit, repo.owner.login, repo.name, topic);
      processedRepos++;
      console.log(`processed ${processedRepos}`);
    }

    if (numRepos !== -1 && processedRepos >= numRepos) break;
  }
}

const { token, topic, numRepos } = getInput();
console.log(
  `Starting process with token: REDACTED, topic: ${topic}, numRepos: ${numRepos}`,
);

main(token, topic, numRepos);