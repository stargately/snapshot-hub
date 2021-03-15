global['fetch'] = require('node-fetch');
import express from 'express';
import snapshot from '@snapshot-labs/snapshot.js';
import { spaces } from './helpers/spaces';
import db from './helpers/mysql';
import relayer from './helpers/relayer';
import { pinJson } from './helpers/ipfs';
import { jsonParse, sendError, formatMessage } from './helpers/utils';
import {
  storeProposal,
  storeVote,
  storeSettings,
  loadSpace,
  archiveProposal
} from './helpers/adapters/mysql';
import pkg from '../package.json';

const router = express.Router();
const network = process.env.NETWORK || 'testnet';

router.get('/', (req, res) => {
  return res.json({
    name: pkg.name,
    network,
    version: pkg.version,
    tag: 'alpha',
    relayer: relayer.address
  });
});

router.get('/spaces', (req, res) => {
  return res.json(spaces);
});

router.get('/spaces/:key?', (req, res) => {
  const { key } = req.params;
  return res.json(key ? spaces[key] : spaces);
});

router.get('/:space/proposals', async (req, res) => {
  const { space } = req.params;
  const query =
    "SELECT * FROM messages WHERE type = 'proposal' AND space = ? ORDER BY timestamp DESC";
  db.queryAsync(query, [space]).then(messages => {
    res.json(
      Object.fromEntries(messages.map(message => formatMessage(message)))
    );
  });
});

router.get('/timeline', async (req, res) => {
  const query =
    "SELECT * FROM messages WHERE type = 'proposal' ORDER BY timestamp DESC LIMIT 30";
  db.queryAsync(query).then(messages => {
    res.json(
      Object.fromEntries(messages.map(message => formatMessage(message)))
    );
  });
});

router.get('/:space/proposal/:id', async (req, res) => {
  const { space, id } = req.params;
  const query = `SELECT * FROM messages WHERE type = 'vote' AND space = ? AND JSON_EXTRACT(payload, "$.proposal") = ? ORDER BY timestamp ASC`;
  db.queryAsync(query, [space, id]).then(messages => {
    res.json(
      Object.fromEntries(
        messages.map(message => {
          const metadata = JSON.parse(message.metadata);
          return [
            message.address,
            {
              address: message.address,
              msg: {
                version: message.version,
                timestamp: message.timestamp.toString(),
                space: message.space,
                type: message.type,
                payload: JSON.parse(message.payload)
              },
              sig: message.sig,
              authorIpfsHash: message.id,
              relayerIpfsHash: metadata.relayer_ipfs_hash
            }
          ];
        })
      )
    );
  });
});

router.get('/voters', async (req, res) => {
  const { from = 0, to = 1e24 } = req.query;
  const spacesArr = req.query.spaces ? req.query.spaces.split(',') : [];
  const spacesStr = req.query.spaces ? 'AND space IN (?)' : '';
  const query = `SELECT address, timestamp, space FROM messages WHERE type = 'vote' AND timestamp >= ? AND timestamp <= ? ${spacesStr} GROUP BY address ORDER BY timestamp DESC`;
  const messages = await db.queryAsync(query, [from, to, spacesArr]);
  res.json(messages);
});

router.post('/message', async (req, res) => {
  const body = req.body;
  const msg = jsonParse(body.msg);
  const now = Date.now() / 1e3;
  const ts = now.toFixed();
  const upts = (now + 300).toFixed();
  // const minBlock = (3600 * 24) / 15;

  if (!body || !body.address || !body.msg || !body.sig)
    return sendError(res, 'wrong message body');

  if (
    Object.keys(msg).length !== 5 ||
    !msg.space ||
    !msg.payload ||
    Object.keys(msg.payload).length === 0
  )
    return sendError(res, 'wrong signed message');

  if (!spaces[msg.space] && msg.type !== 'settings')
    return sendError(res, 'unknown space');

  if (
    !msg.timestamp ||
    typeof msg.timestamp !== 'string' ||
    msg.timestamp > upts
  )
    return sendError(res, 'wrong timestamp');

  if (!msg.version || msg.version !== pkg.version)
    return sendError(res, 'wrong version');

  if (
    !msg.type ||
    !['proposal', 'vote', 'settings', 'delete-proposal'].includes(msg.type)
  )
    return sendError(res, 'wrong message type');

  console.log('message1', msg);

  // TODO: don't verify signature for now
  // if (
  //   !(await verifySignature(
  //     body.address,
  //     body.sig,
  //     hashPersonalMessage(body.msg)
  //   ))
  // )
  // return sendError(res, 'wrong signature');

  if (msg.type === 'delete-proposal') {
    const query = `SELECT address FROM messages WHERE type = 'proposal' AND id = ?`;
    const propasalSigner = await db.queryAsync(query, [msg.payload.proposal]);
    if (propasalSigner[0].address !== body.address) {
      return sendError(res, 'wrong signer');
    }
  }

  if (msg.type === 'proposal') {
    if (
      Object.keys(msg.payload).length !== 7 ||
      !msg.payload.choices ||
      msg.payload.choices.length < 2 ||
      // // !msg.payload.snapshot ||
      !msg.payload.metadata
    )
      return sendError(res, 'wrong proposal format');

    if (
      !msg.payload.name ||
      msg.payload.name.length > 256 ||
      !msg.payload.body ||
      msg.payload.body.length > 4e4
    )
      return sendError(res, 'wrong proposal size');

    if (
      typeof msg.payload.metadata !== 'object' ||
      JSON.stringify(msg.payload.metadata).length > 2e4
    )
      return sendError(res, 'wrong proposal metadata');

    if (
      !msg.payload.start ||
      // ts > msg.payload.start ||
      !msg.payload.end ||
      msg.payload.start >= msg.payload.end
    )
      return sendError(res, 'wrong proposal period');
  }

  if (msg.type === 'vote') {
    if (
      Object.keys(msg.payload).length !== 3 ||
      !msg.payload.proposal ||
      !msg.payload.choice ||
      !msg.payload.metadata
    )
      return sendError(res, 'wrong vote format');

    if (
      typeof msg.payload.metadata !== 'object' ||
      JSON.stringify(msg.payload.metadata).length > 1e4
    )
      return sendError(res, 'wrong vote metadata');

    const query = `SELECT * FROM messages WHERE space = ? AND id = ? AND type = 'proposal'`;
    const proposals = await db.queryAsync(query, [
      msg.space,
      msg.payload.proposal
    ]);
    if (!proposals[0]) return sendError(res, 'unknown proposal');
    const payload = jsonParse(proposals[0].payload);
    if (ts > payload.end || payload.start > ts)
      return sendError(res, 'not in voting window');
  }

  if (msg.type === 'settings') {
    if (
      snapshot.utils.validateSchema(snapshot.schemas.space, msg.payload) !==
      true
    )
      return sendError(res, 'wrong space format');

    // TODO: fix this
    // const spaceUri = await getSpaceUri(msg.space);
    // if (!spaceUri.includes(body.address)) {
    //   return sendError(res, 'not allowed');
    // }
  }

  const authorIpfsRes = await pinJson(`snapshot/${body.sig}`, {
    address: body.address,
    msg: body.msg,
    sig: body.sig,
    version: '2'
  });

  const relayerSig = await relayer.signMessage(authorIpfsRes);
  const relayerIpfsRes = await pinJson(`snapshot/${relayerSig}`, {
    address: relayer.address,
    msg: authorIpfsRes,
    sig: relayerSig,
    version: '2'
  });

  if (msg.type === 'delete-proposal') {
    await archiveProposal(msg.payload.proposal);
  }

  if (msg.type === 'proposal') {
    await storeProposal(msg.space, body, authorIpfsRes, relayerIpfsRes);
  }

  if (msg.type === 'vote') {
    await storeVote(msg.space, body, authorIpfsRes, relayerIpfsRes);
  }

  if (msg.type === 'settings') {
    try {
      await storeSettings(msg.space, body);
      spaces[msg.space] = msg.payload;
      setTimeout(async () => {
        const space = await loadSpace([msg.space, body.address]);
        if (space) spaces[msg.space] = space;
      }, 75e3);
    } catch (e) {
      console.log(e);
    }
  }

  return res.json({ ipfsHash: authorIpfsRes });
});

export default router;
