import { jest } from '@jest/globals';

const mockSend = jest.fn<() => Promise<unknown>>();
jest.unstable_mockModule('firebase-admin/messaging', () => ({
  getMessaging: () => ({ send: mockSend }),
}));
jest.unstable_mockModule('../../src/config/firebase.js', () => ({
  getFirebaseApp: jest.fn(),
  getStorageBucket: jest.fn(),
}));

const { sendPush } = await import('../../src/services/push.service.js');

beforeEach(() => mockSend.mockReset());

describe('sendPush', () => {
  it('returns sent on success', async () => {
    mockSend.mockResolvedValueOnce('msg-id-123');
    const r = await sendPush('tok', { title: 't', body: 'b' });
    expect(r).toBe('sent');
  });

  it('returns token_invalid on registration-token-not-registered', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('x'), {
      code: 'messaging/registration-token-not-registered',
    }));
    const r = await sendPush('tok', { title: 't', body: 'b' });
    expect(r).toBe('token_invalid');
  });

  it('returns token_invalid on invalid-argument', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('x'), {
      code: 'messaging/invalid-argument',
    }));
    const r = await sendPush('tok', { title: 't', body: 'b' });
    expect(r).toBe('token_invalid');
  });

  it('returns failed on transient error', async () => {
    mockSend.mockRejectedValueOnce(Object.assign(new Error('boom'), {
      code: 'messaging/internal',
    }));
    const r = await sendPush('tok', { title: 't', body: 'b' });
    expect(r).toBe('failed');
  });

  it('forwards data payload', async () => {
    mockSend.mockResolvedValueOnce('ok');
    await sendPush('tok', { title: 't', body: 'b', data: { route: '/foo' } });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      token: 'tok',
      data: { route: '/foo' },
    }));
  });
});
