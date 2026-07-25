import type { TransferProtocol } from '../types';
import { FtpRemoteClient } from './ftpClient';
import type { RemoteClient } from './remoteClient';
import { SftpRemoteClient } from './sftpClient';

export function createRemoteClient(protocol: TransferProtocol): RemoteClient {
  return protocol === 'sftp' ? new SftpRemoteClient() : new FtpRemoteClient();
}
