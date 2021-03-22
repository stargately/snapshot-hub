import fetch from 'node-fetch';
import fleek from '@fleekhq/fleek-storage-js';

const config: any = {
  apiKey: process.env.FLEEK_API_KEY,
  apiSecret: process.env.FLEEK_API_SECRET
};

export async function pinJson(key: string, body) {
  const input = config;
  input.key = key;
  input.data = JSON.stringify(body);
  const result = await fleek.upload(input);
  const ipfsHash = result.hashV0;

  fetch(`https://ipfs2arweave.com/permapin/${ipfsHash}`)
    .then(res => res.json())
    .then(json => console.log('Arweave success', json))
    .catch(e => console.error('Arweave error', e));

  return ipfsHash;
}
