export interface MailboxConfig {
  email: string;
  imap: {
    host: string;
    port: number;
    secure: true;
    username: string;
    password: string;
  };
  allowedSenders: string[];
  allowedSenderDomains: string[];
  loginKeywords: string[];
}

export interface AppConfig {
  mailboxes: MailboxConfig[];
  port: number;
}

export interface InboundMessage {
  uid: number;
  receivedAt: Date;
  from: string[];
  subject: string;
  text: string;
  html: string;
}

export interface MailboxClient {
  connect(): Promise<void>;
  openInbox(): Promise<number>;
  listNewMessages(minimumUid: number): Promise<InboundMessage[]>;
  waitForNewMessage(signal: AbortSignal, timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export interface CodeWatcher {
  watch(mailbox: MailboxConfig, requestedAt: Date, signal: AbortSignal): Promise<string>;
}
