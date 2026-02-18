import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('Slack channel JID: starts with C', () => {
    const jid = 'C012345ABCD';
    expect(/^[CDG][A-Z0-9]+$/.test(jid)).toBe(true);
  });

  it('Slack DM JID: starts with D', () => {
    const jid = 'D012345ABCD';
    expect(/^[CDG][A-Z0-9]+$/.test(jid)).toBe(true);
  });

  it('unknown JID format: does not match Slack patterns', () => {
    const jid = 'unknown:12345';
    expect(/^[CDG][A-Z0-9]+$/.test(jid)).toBe(false);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only channel/group JIDs (C/G prefix)', () => {
    storeChatMetadata('C012345ABCD', '2024-01-01T00:00:01.000Z', 'Channel 1');
    storeChatMetadata('D012345ABCD', '2024-01-01T00:00:02.000Z', 'DM');
    storeChatMetadata('C098765WXYZ', '2024-01-01T00:00:03.000Z', 'Channel 2');

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => /^[CG]/.test(g.jid))).toBe(true);
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('C012345ABCD', '2024-01-01T00:00:01.000Z', 'Channel');

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('C012345ABCD');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata('C012345ABCD', '2024-01-01T00:00:01.000Z', 'Registered');
    storeChatMetadata('C098765WXYZ', '2024-01-01T00:00:02.000Z', 'Unregistered');

    _setRegisteredGroups({
      'C012345ABCD': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'C012345ABCD');
    const unreg = groups.find((g) => g.jid === 'C098765WXYZ');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata('C000000OLD0', '2024-01-01T00:00:01.000Z', 'Old');
    storeChatMetadata('C000000NEW0', '2024-01-01T00:00:05.000Z', 'New');
    storeChatMetadata('C000000MID0', '2024-01-01T00:00:03.000Z', 'Mid');

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('C000000NEW0');
    expect(groups[1].jid).toBe('C000000MID0');
    expect(groups[2].jid).toBe('C000000OLD0');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});
