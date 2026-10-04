import { encodeCft1, type FileTransferManager, type UploadSource } from '../src/file-transfer.js';
import { startMockServer } from './mock-server.js';
import { makeClient } from './test-client-factory.js';
import { waitFor } from './helpers.js';

function controlledSource(): { source: UploadSource; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    release,
    source: {
      filename: 'slow.bin',
      contentType: 'application/octet-stream',
      size: 4,
      async *chunks() {
        yield new Uint8Array([1, 2]);
        await gate;
        yield new Uint8Array([3, 4]);
      },
      async cleanup() {},
    },
  };
}

function managerOf(client: object): FileTransferManager {
  return (client as unknown as { _fileTransfers: FileTransferManager })._fileTransfers;
}

describe('connection-ephemeral file transfer invariants', () => {
  it('never resumes an old upload transfer_id on a reconnected socket', async () => {
    const server = await startMockServer({ autoInitEcho: true });
    const client = makeClient(server, () => {});
    const controlled = controlledSource();
    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);
      const upload = managerOf(client).upload(client.sessionId!, controlled.source);
      await waitFor(() => server.receivedFrames.filter((frame) => frame.startsWith('43465431')).length === 1);
      server.dropConnections();
      await waitFor(() => server.wsConnectionCount >= 2 && client.channelState === 'OPEN', 5000);
      const binaryCount = server.receivedFrames.filter((frame) => frame.startsWith('43465431')).length;
      controlled.release();
      await expect(upload).rejects.toMatchObject({ code: 'file_transfer_interrupted' });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(server.receivedFrames.filter((frame) => frame.startsWith('43465431'))).toHaveLength(binaryCount);
    } finally {
      controlled.release();
      await client.disconnect();
      await server.close();
    }
  });

  it.each([
    ['malformed', new Uint8Array([0x43, 0x46])],
    ['unknown transfer', encodeCft1('ft_ffffffffffffffffffffffffffffffff', 0, new Uint8Array([1]))],
  ])('aborts active file operations for %s inbound binary without failing the session', async (_name, frame) => {
    const server = await startMockServer({ autoInitEcho: true });
    const client = makeClient(server, () => {});
    const controlled = controlledSource();
    try {
      await client.connect();
      await waitFor(() => client.sessionId !== null);
      const upload = managerOf(client).upload(client.sessionId!, controlled.source);
      await waitFor(() => server.receivedFrames.some((received) => received.startsWith('43465431')));
      managerOf(client).handleBinary(frame);
      controlled.release();
      await expect(upload).rejects.toMatchObject({ code: 'invalid_file_transfer' });
      expect(client.channelState).toBe('OPEN');
    } finally {
      controlled.release();
      await client.disconnect();
      await server.close();
    }
  });
});
