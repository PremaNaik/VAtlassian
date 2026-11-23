
import { useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/bridge';
import Button from '@atlaskit/button';
import SectionMessage from '@atlaskit/section-message';
import { QRCodeSVG } from 'qrcode.react';

import { Card, CodeInput, Loading, Page, Stack } from '../ui/primitives';
import { useConfigurationUpdates } from '../lib/configurationUpdates';
import {
  biometricStatus,
  enrolBiometric
} from '../panel/deviceAuth';

type Recovery = {
  resetGrant: { expiresAt: number } | null;
  administrators: string[] | null;
  onlyAdministrator: boolean;
};

type BiometricDevice = {
  credentialId?: string;
  label?: string | null;
  enrolledAt?: number;
  lastUsedAt?: number | null;
  synced?: boolean;
  usable?: boolean | null;
};

type BiometricState = {
  enrolled: boolean;
  usableHere: boolean | null;
  enrolledElsewhere: boolean;
  devices: BiometricDevice[];
};

type PageMessage = {
  type: 'success' | 'error' | 'warning';
  text: string;
};

const EMPTY_RECOVERY: Recovery = {
  resetGrant: null,
  administrators: null,
  onlyAdministrator: false
};

/**
 * Authenticator enrollment page.
 *
 * Supports TOTP and WebAuthn biometric registration in the same
 * Jira personal settings page.
 *
 * TOTP credentials and WebAuthn credentials are handled separately.
 */
export default function TotpEnrollment() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);

  const [isEnrolled, setIsEnrolled] = useState<boolean | null>(null);
  const [isLocked, setIsLocked] = useState(false);

  const [recovery, setRecovery] = useState<Recovery>(EMPTY_RECOVERY);

  const [qrUri, setQrUri] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const [message, setMessage] = useState<PageMessage | null>(null);
  const [biometricMessage, setBiometricMessage] =
    useState<PageMessage | null>(null);

  const [biometricLoading, setBiometricLoading] = useState(true);
  const [biometric, setBiometric] = useState<BiometricState>({
    enrolled: false,
    usableHere: null,
    enrolledElsewhere: false,
    devices: []
  });

  const statusSequence = useRef(0);
  const biometricSequence = useRef(0);

  /**
   * Load biometric registration status independently.
   * A biometric status failure must not hide the TOTP setup page.
   */
  const checkBiometricStatus = async () => {
    const sequence = ++biometricSequence.current;

    setBiometricLoading(true);

    try {
      const response = await biometricStatus();

      if (sequence !== biometricSequence.current) return;

      if (!response.ok) {
        setBiometricMessage({
          type: 'error',
          text: response.error || 'Could not check biometric registration.'
        });
        return;
      }

      setBiometric({
        enrolled: response.enrolled === true,
        usableHere: response.usableHere ?? null,
        enrolledElsewhere: response.enrolledElsewhere === true,
        devices: Array.isArray(response.devices)
          ? response.devices as BiometricDevice[]
          : []
      });

      setBiometricMessage(null);
    } catch (error) {
      if (sequence !== biometricSequence.current) return;

      setBiometricMessage({
        type: 'error',
        text: error instanceof Error
          ? error.message
          : 'Could not check biometric registration.'
      });
    } finally {
      if (sequence === biometricSequence.current) {
        setBiometricLoading(false);
      }
    }
  };

  /**
   * Load TOTP status and recovery information.
   */
  const checkStatus = async () => {
    const sequence = ++statusSequence.current;

    try {
      const response = await invoke('totp:checkStatus') as {
        success: boolean;
        isEnrolled: boolean;
        state?: string;
        error?: string;
      } & Partial<Recovery>;

      if (sequence !== statusSequence.current) return;

      if (response.success) {
        setIsEnrolled(response.isEnrolled);
        setIsLocked(response.state === 'LOCKED');

        setRecovery({
          resetGrant: response.resetGrant ?? null,
          administrators: response.administrators ?? null,
          onlyAdministrator: response.onlyAdministrator === true
        });
      } else {
        setIsEnrolled(null);
        setQrUri(null);

        setMessage({
          type: 'error',
          text: response.error || 'Could not check your authenticator.'
        });
      }
    } catch (error) {
      if (sequence !== statusSequence.current) return;

      setIsEnrolled(null);
      setQrUri(null);

      setMessage({
        type: 'error',
        text: error instanceof Error
          ? error.message
          : 'Could not check your authenticator.'
      });
    } finally {
      if (sequence === statusSequence.current) {
        setLoading(false);
      }
    }

    void checkBiometricStatus();
  };

  useEffect(() => {
    void checkStatus();

    return () => {
      ++statusSequence.current;
      ++biometricSequence.current;
    };
  }, []);

  useConfigurationUpdates(() => {
    if (!busy && !biometricBusy && !qrUri) {
      return checkStatus();
    }
  });

  /**
   * Start TOTP enrollment.
   */
  const startEnrolment = async () => {
    if (busy) return;

    ++statusSequence.current;

    setBusy(true);
    setMessage(null);

    try {
      const response = await invoke('totp:enrol') as {
        success: boolean;
        uri?: string;
        error?: string;
      };

      if (response.success && response.uri) {
        setQrUri(response.uri);
        setCode('');
      } else {
        setMessage({
          type: 'error',
          text: response.error || 'Could not start enrollment.'
        });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error
          ? error.message
          : 'Could not start enrollment.'
      });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Confirm TOTP using the six-digit code.
   */
  const confirm = async () => {
    if (code.length !== 6 || busy) return;

    setBusy(true);
    setMessage(null);

    try {
      const response = await invoke('totp:confirm', {
        code
      }) as {
        success: boolean;
        error?: string;
        reason?: string;
      };

      if (response.success) {
        setMessage({
          type: 'success',
          text: 'Your authenticator is set up. You can now sign records.'
        });

        setQrUri(null);
        setCode('');

        await checkStatus();
      } else {
        setMessage({
          type: 'error',
          text: response.error ||
            'That code was not accepted. Try the next one your app shows.'
        });

        setCode('');

        if (
          response.reason === 'CREDENTIAL_LOCKED' ||
          response.reason === 'ENROLMENT_EXPIRED'
        ) {
          setQrUri(null);
          await checkStatus();
        }
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error
          ? error.message
          : 'Could not confirm your authenticator.'
      });

      setCode('');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Start browser-native biometric enrollment.
   *
   * Uses the existing WebAuthn popup implementation in deviceAuth.ts.
   */
  const registerBiometric = async () => {
    if (biometricBusy) return;

    setBiometricBusy(true);
    setBiometricMessage(null);

    try {
      const result = await enrolBiometric();

      if (!result.ok) {
        setBiometricMessage({
          type: 'error',
          text: result.error || 'Biometric registration could not be completed.'
        });
        return;
      }

      setBiometricMessage({
        type: 'success',
        text: 'Your biometric device has been registered successfully.'
      });

      await checkBiometricStatus();
    } catch (error) {
      setBiometricMessage({
        type: 'error',
        text: error instanceof Error
          ? error.message
          : 'Biometric registration could not be completed.'
      });
    } finally {
      setBiometricBusy(false);
    }
  };

  /**
   * Refresh both authentication statuses.
   */
  const refresh = async () => {
    setBusy(true);
    setMessage(null);
    setBiometricMessage(null);

    try {
      await checkStatus();
    } finally {
      setBusy(false);
    }
  };

  const refreshBiometric = async () => {
    if (biometricBusy) return;

    setBiometricMessage(null);
    await checkBiometricStatus();
  };

  if (isEnrolled === null) {
    if (loading) {
      return <Loading label="Checking your authenticator…" />;
    }

    return (
      <Page title="Authenticator status unavailable">
        <SectionMessage appearance="error">
          <p>
            {message?.text ?? 'Could not check your authenticator.'}
          </p>
        </SectionMessage>

        <Button
          isDisabled={busy}
          onClick={refresh}
        >
          Retry
        </Button>
      </Page>
    );
  }

  return (
    <Page
      eyebrow="Approval & baseline"
      title="Your authenticator app"
      lead={
        <>
          Signing a record takes two things: being signed in to Jira, and
          a six-digit code from an authenticator app that only you hold.
          You can also register a biometric device for supported
          biometric approval.
        </>
      }
    >
      {message && (
        <div style={{ marginBottom: '20px' }}>
          <SectionMessage appearance={message.type}>
            <p>{message.text}</p>
          </SectionMessage>
        </div>
      )}

      {/* TOTP AUTHENTICATION */}
      {qrUri ? (
        <Card
          title="Scan this with your authenticator app"
          subtitle="Microsoft Authenticator, Google Authenticator, 1Password or any other TOTP app will work."
        >
          <Stack>
            <ol className="va-steps">
              <li>Open your authenticator app.</li>
              <li>
                Choose <strong>Add account</strong>, then{' '}
                <strong>Other account</strong>.
              </li>
              <li>Scan the code below.</li>
              <li>
                Type the six digits it shows, to prove the setup worked.
              </li>
            </ol>

            <div className="va-qr">
              <QRCodeSVG value={qrUri} size={190} />
            </div>

            <div className="va-field">
              <span className="va-label">Code from your app</span>

              <CodeInput
                value={code}
                onChange={setCode}
                onSubmit={confirm}
                disabled={busy}
              />

              <span className="va-hint">
                Codes change every 30 seconds. If one is rejected,
                wait for the next.
              </span>
            </div>

            <div className="va-row">
              <Button
                appearance="primary"
                isDisabled={busy || code.length !== 6}
                onClick={confirm}
              >
                {busy ? 'Checking…' : 'Confirm setup'}
              </Button>

              <Button
                appearance="subtle"
                isDisabled={busy}
                onClick={() => {
                  setQrUri(null);
                  setCode('');
                }}
              >
                Cancel
              </Button>
            </div>
          </Stack>
        </Card>
      ) : isLocked ? (
        <Stack>
          <SectionMessage
            appearance="error"
            title="Your authenticator is locked"
          >
            <p>
              Too many incorrect codes were entered, so it can no longer
              sign. An administrator must authorize setting it up again.
            </p>
          </SectionMessage>

          <ReplaceCard
            recovery={recovery}
            busy={busy}
            label="Set up my authenticator again"
            onStart={startEnrolment}
            onRefresh={refresh}
          />
        </Stack>
      ) : isEnrolled ? (
        <Stack>
          <SectionMessage
            appearance="success"
            title="Your authenticator is active"
          >
            <p>You can sign electronic records. No further TOTP setup is needed.</p>
          </SectionMessage>

          <Card
            title="Replace your authenticator"
            subtitle="Use this if you have changed phone or no longer have your enrolled app."
          >
            <p
              className="va-hint"
              style={{ marginBottom: '14px' }}
            >
              Setting up a new authenticator replaces the current one.
              Signatures you have already given are unaffected.
            </p>

            <ReplaceCard
              recovery={recovery}
              busy={busy}
              label="Set up a new authenticator"
              onStart={startEnrolment}
              onRefresh={refresh}
            />
          </Card>
        </Stack>
      ) : (
        <Card
          title="You cannot sign yet"
          subtitle="No authenticator app is linked to your account."
        >
          <p
            className="va-hint"
            style={{ marginBottom: '14px' }}
          >
            Until you set one up, work items requiring your signature
            will keep waiting. The signing screens will show what needs
            signing but will not accept a signature.
          </p>

          <Button
            appearance="primary"
            onClick={startEnrolment}
            isDisabled={busy}
          >
            {busy ? 'Starting…' : 'Set up my authenticator'}
          </Button>
        </Card>
      )}

      {/* BIOMETRIC AUTHENTICATION */}
      <div style={{ marginTop: '24px' }}>
        <Card
          title="Biometric Authentication"
          subtitle="Register a supported authenticator, such as Windows Hello, a fingerprint-enabled device, Face ID or a security key."
        >
          {biometricMessage && (
            <div style={{ marginBottom: '16px' }}>
              <SectionMessage appearance={biometricMessage.type}>
                <p>{biometricMessage.text}</p>
              </SectionMessage>
            </div>
          )}

          {biometricLoading ? (
            <Loading label="Checking biometric registration…" />
          ) : biometric.enrolled && biometric.usableHere !== false ? (
            <Stack>
              <SectionMessage
                appearance="success"
                title="Biometric authentication is active"
              >
                <p>
                  Your biometric device is registered and available
                  for supported signing operations.
                </p>
              </SectionMessage>

              <p className="va-hint">
                Registered authenticators: {biometric.devices.length}
              </p>

              {biometric.devices.map((device, index) => (
                <div
                  key={device.credentialId ?? index}
                  style={{
                    padding: '12px',
                    border: '1px solid #DFE1E6',
                    borderRadius: '6px',
                    marginBottom: '8px'
                  }}
                >
                  <strong>
                    {device.label || `Biometric device ${index + 1}`}
                  </strong>

                  <p className="va-hint">
                    Registered
                    {device.enrolledAt
                      ? ` on ${new Date(device.enrolledAt).toLocaleDateString()}`
                      : ''}
                  </p>
                </div>
              ))}
            </Stack>
          ) : (
            <Stack>
              {biometric.enrolledElsewhere && (
                <SectionMessage
                  appearance="warning"
                  title="A biometric device is registered elsewhere"
                >
                  <p>
                    Your existing biometric registration is not usable
                    on this Jira site. You can register a device for
                    this site separately.
                  </p>
                </SectionMessage>
              )}

              {!biometric.enrolledElsewhere && (
                <p className="va-hint">
                  No biometric device is currently linked to your account.
                  Register one to use biometric approval.
                </p>
              )}

              <div className="va-row">
                <Button
                  appearance="primary"
                  isDisabled={biometricBusy}
                  onClick={registerBiometric}
                >
                  {biometricBusy
                    ? 'Waiting for device…'
                    : 'Register biometric device'}
                </Button>

                <Button
                  appearance="subtle"
                  isDisabled={biometricBusy}
                  onClick={refreshBiometric}
                >
                  Refresh status
                </Button>
              </div>

              <p className="va-hint">
                Your browser will open a device confirmation window.
                Follow the Windows Hello, fingerprint or security-key
                prompt to complete registration.
              </p>
            </Stack>
          )}
        </Card>
      </div>
    </Page>
  );
}

/**
 * Administrator-authorized TOTP replacement.
 */
function ReplaceCard({
  recovery,
  busy,
  label,
  onStart,
  onRefresh
}: {
  recovery: Recovery;
  busy: boolean;
  label: string;
  onStart: () => void;
  onRefresh: () => void;
}) {
  if (recovery.resetGrant) {
    return (
      <Stack>
        <SectionMessage
          appearance="success"
          title="An administrator has authorized a replacement"
        >
          <p>
            You can set up a new authenticator until{' '}
            {new Date(recovery.resetGrant.expiresAt).toLocaleString()}.
            The authorization works once.
          </p>
        </SectionMessage>

        <div className="va-row">
          <Button
            appearance="primary"
            onClick={onStart}
            isDisabled={busy}
          >
            {busy ? 'Starting…' : label}
          </Button>
        </div>
      </Stack>
    );
  }

  const others = recovery.administrators;

  return (
    <Stack>
      <SectionMessage
        appearance="information"
        title="An administrator needs to authorize this first"
      >
        {recovery.onlyAdministrator ? (
          <p>
            You are the only VAtlassian administrator, and nobody can
            authorize their own reset. Add a second administrator under{' '}
            <strong>Jira settings → Apps → VAtlassian → Administrators</strong>,
            then ask them to issue your reset under{' '}
            <strong>Credentials &amp; recovery</strong>.
          </p>
        ) : (
          <p>
            Ask{' '}
            {others && others.length
              ? <strong>{others.join(', ')}</strong>
              : others
                ? 'a Jira administrator to appoint a VAtlassian administrator, then ask them'
                : 'a VAtlassian administrator'}
            {' '}to issue you a reset under{' '}
            <strong>
              Jira settings → Apps → VAtlassian → Credentials &amp; recovery
            </strong>.
            {' '}The reset lasts 24 hours; come back here once it is issued.
          </p>
        )}
      </SectionMessage>

      <div className="va-row">
        <Button
          onClick={onRefresh}
          isDisabled={busy}
        >
          {busy ? 'Checking…' : 'Check again'}
        </Button>
      </div>
    </Stack>
  );
}
