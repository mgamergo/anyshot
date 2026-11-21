import '../common/ui.css';
import './settings.css';
import { type ComponentChildren, cloneElement, isValidElement, render } from 'preact';
import { useEffect, useId, useState } from 'preact/hooks';
import logo from '../../../resources/icon-256.png';
import { type AutoBeautify, SCREENSHOT_MODES } from '../../shared/background';
import { expandTemplate } from '../../shared/filename';
import type { HotkeyReport, InvokeRes } from '../../shared/ipc';
import { RECORDING_QUALITY_OPTIONS } from '../../shared/recording-quality';
import {
  ACCELERATOR,
  type DeepPartial,
  HOTKEY_ACTIONS,
  HOTKEY_LABELS,
  type HotkeyAction,
  type Settings,
  TOOL_IDS,
  toolsPageDefaults,
} from '../../shared/settings';
import { BackgroundControls } from '../common/background-controls';
import { Icon, type IconName } from '../common/icons';
import { applyTheme } from '../common/theme';
import { TOOL_LABELS } from '../common/tools';

const api = window.anyshot;
type Tab =
  | 'general'
  | 'capture'
  | 'output'
  | 'shortcuts'
  | 'tools'
  | 'recording'
  | 'uploads'
  | 'about';
const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'capture', label: 'Capture' },
  { id: 'output', label: 'Output' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'tools', label: 'Tools' },
  { id: 'recording', label: 'Recording' },
  { id: 'uploads', label: 'Uploads' },
  { id: 'about', label: 'About' },
];

let patch: (p: DeepPartial<Settings>) => void = () => {};

let submitSettings: (request: Promise<unknown>) => void = () => {};

function Row(props: {
  label: string;
  hint?: string;
  group?: boolean;
  children: ComponentChildren;
}) {
  const id = useId();
  const control =
    !props.group && isValidElement(props.children)
      ? cloneElement(props.children, { id })
      : props.children;
  const content = (
    <>
      <span class="label">
        <span id={props.group ? id : undefined}>{props.label}</span>
        {props.hint && <small>{props.hint}</small>}
      </span>
      <span class="control">{control}</span>
    </>
  );
  return props.group ? (
    <fieldset class="row-group" aria-labelledby={id}>
      <div class="row">{content}</div>
    </fieldset>
  ) : (
    <label class="row" htmlFor={id}>
      {content}
    </label>
  );
}

function Toggle(props: {
  id?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) {
  return (
    <input
      id={props.id}
      type="checkbox"
      class="toggle"
      checked={props.value}
      data-testid={props.testId}
      onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)}
    />
  );
}

/** Shows the value while dragging; saves once on release. */
function FrameSlider(props: {
  label: string;
  field: 'padding' | 'radius' | 'shadow';
  value: number;
  min: number;
  max: number;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const shown = dragging ?? props.value;
  return (
    <label>
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={1}
        value={shown}
        data-testid={`auto-beautify-${props.field}`}
        onInput={(e) => setDragging(Number(e.currentTarget.value))}
        onChange={(e) => {
          setDragging(null);
          patch({ capture: { beautify: { [props.field]: Number(e.currentTarget.value) } } });
        }}
      />
      <span class="val">{shown}</span>
    </label>
  );
}

function ScreenshotBeautify({ value }: { value: AutoBeautify }) {
  return (
    <>
      <Row label="Automatic Beautify" hint="Add your chosen background to new screenshots.">
        <Toggle
          value={value.enabled}
          onChange={(enabled) => patch({ capture: { beautify: { enabled } } })}
        />
      </Row>
      {value.enabled && (
        <div class="auto-beautify">
          <fieldset class="auto-beautify-modes">
            <legend>Apply to</legend>
            {SCREENSHOT_MODES.map(([mode, label]) => (
              <label key={mode}>
                <input
                  type="checkbox"
                  checked={value.modes[mode]}
                  onChange={(e) =>
                    patch({ capture: { beautify: { modes: { [mode]: e.currentTarget.checked } } } })
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <fieldset class="auto-beautify-frame">
            <legend>Frame</legend>
            <FrameSlider label="Padding" field="padding" value={value.padding} min={16} max={96} />
            <FrameSlider label="Corners" field="radius" value={value.radius} min={0} max={30} />
            <FrameSlider label="Shadow" field="shadow" value={value.shadow} min={0} max={100} />
          </fieldset>
          <details class="auto-beautify-background">
            <summary>Default background</summary>
            <BackgroundControls
              value={value.background}
              onSelect={(background) => patch({ capture: { beautify: { background } } })}
            />
          </details>
        </div>
      )}
    </>
  );
}

function Select<T extends string>(props: {
  id?: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
}) {
  return (
    <select
      id={props.id}
      value={props.value}
      onChange={(e) => props.onChange((e.target as HTMLSelectElement).value as T)}
    >
      {props.options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** Mutually exclusive icon buttons. Native radios give arrow-key and focus handling. */
function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; icon: IconName }[];
  onChange: (v: T) => void;
  testId?: string;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={props.label} class="segmented" data-testid={props.testId}>
      {props.options.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === props.value}
            onChange={() => props.onChange(option.value)}
          />
          <Icon name={option.icon} size={16} />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

const THEMES = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'light', label: 'Light', icon: 'sun' },
] as const;

function NumberField(props: {
  id?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <span class="number">
      <input
        id={props.id}
        type="number"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number((e.target as HTMLInputElement).value))}
      />
      {props.suffix && <span>{props.suffix}</span>}
    </span>
  );
}

function Text(props: {
  id?: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  testId?: string;
}) {
  return (
    <input
      id={props.id}
      type="text"
      value={props.value}
      placeholder={props.placeholder}
      data-testid={props.testId}
      onChange={(e) => props.onChange((e.target as HTMLInputElement).value)}
    />
  );
}

/** Write-only: the stored value is never sent to this window. */
function Secret(props: {
  id?: string;
  stored: boolean;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      id={props.id}
      type="password"
      // Uncontrolled: a controlled value="" would wipe what the user is typing whenever
      // the page re-renders (e.g. another setting saved in between). Cleared once sent.
      placeholder={props.stored ? '•••••••• (stored)' : (props.placeholder ?? '')}
      onChange={(e) => {
        const input = e.target as HTMLInputElement;
        props.onChange(input.value);
        input.value = '';
      }}
    />
  );
}

function Folder(props: { value: string; fallback: string; which: 'output' | 'recording' }) {
  return (
    <span class="folder">
      <span class="path" title={props.value || props.fallback}>
        {props.value || props.fallback}
      </span>
      <button
        type="button"
        onClick={() => submitSettings(api.invoke('settings:choose-dir', props.which))}
      >
        Choose…
      </button>
      {props.value && (
        <button
          type="button"
          onClick={() =>
            patch(
              props.which === 'output'
                ? { output: { saveDir: '' } }
                : { recording: { saveDir: '' } },
            )
          }
        >
          Default
        </button>
      )}
    </span>
  );
}

/** Turns a key press into an Electron accelerator such as `Alt+Shift+X`. */
export function acceleratorFor(e: KeyboardEvent): string | null {
  const named: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Return',
    Escape: 'Escape',
    '+': 'Plus',
    '-': 'Minus',
  };
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const key = named[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  const parts = [
    e.ctrlKey && 'CommandOrControl',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
    e.metaKey && 'Super',
    key,
  ].filter(Boolean) as string[];
  const accel = parts.join('+');
  // Function keys and Print Screen may stand alone; everything else needs a modifier.
  const standalone = /^F\d+$|^PrintScreen$/.test(key);
  if (!standalone && parts.length < 2) return null;
  return ACCELERATOR.test(accel) ? accel : null;
}

function Shortcut(props: {
  action: HotkeyAction;
  value: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [recording, setRecording] = useState(false);
  return (
    <span class="shortcut">
      <button
        type="button"
        class={`keys${recording ? ' recording' : ''}${props.invalid ? ' invalid' : ''}`}
        data-testid={`hotkey-${props.action}`}
        aria-invalid={props.invalid ? 'true' : undefined}
        aria-describedby={props.describedBy}
        aria-label={`${HOTKEY_LABELS[props.action]} shortcut (${recording ? 'press keys' : props.value || 'none'})`}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          if (e.key === 'Escape') return setRecording(false);
          const accel = acceleratorFor(e);
          if (!accel) return;
          setRecording(false);
          patch({ hotkeys: { [props.action]: accel } });
        }}
      >
        {recording ? 'Press keys…' : props.value || 'None'}
      </button>
      {props.value && (
        <button
          type="button"
          class="clear"
          title="Clear"
          aria-label={`Clear ${HOTKEY_LABELS[props.action].toLowerCase()} shortcut`}
          onClick={() => patch({ hotkeys: { [props.action]: '' } })}
        >
          ✕
        </button>
      )}
    </span>
  );
}

/** Reset to defaults, confirmed inline: the button turns into Reset / Cancel. */
function ResetTools() {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button
        type="button"
        class="reset"
        data-testid="reset-tools"
        onClick={() => setConfirming(true)}
      >
        Reset to defaults
      </button>
    );
  }
  return (
    <fieldset
      class="confirm"
      aria-label="Reset the Tools page to its defaults?"
      onKeyDown={(e) => {
        if (e.key === 'Escape') setConfirming(false);
      }}
    >
      <span>Show every tool again?</span>
      <button
        type="button"
        class="danger"
        data-testid="reset-tools-confirm"
        onClick={() => {
          setConfirming(false);
          patch(toolsPageDefaults());
        }}
      >
        Reset
      </button>
      <button
        type="button"
        // Focus lands on the safe choice, so Enter right after opening does nothing harmful.
        ref={(el) => el?.focus()}
        data-testid="reset-tools-cancel"
        onClick={() => setConfirming(false)}
      >
        Cancel
      </button>
    </fieldset>
  );
}

function Uploads({ s }: { s: Settings }) {
  const [status, setStatus] = useState<InvokeRes<'secrets:status'> | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const refresh = () =>
    void api
      .invoke('secrets:status')
      .then(setStatus)
      .catch((error: unknown) => {
        setTest(String(error));
      });
  useEffect(refresh, [s.uploads.allowWeakSecretStorage]);
  const setSecret = async (key: string, value: string) => {
    try {
      await api.invoke('secrets:set', { key, value });
    } catch (error) {
      setTest(String(error));
    }
    refresh();
  };
  const has = (key: string) => status?.keys.includes(key) ?? false;
  const u = s.uploads;
  return (
    <>
      <Row label="Provider">
        <Select
          value={u.provider}
          options={[
            ['none', 'None'],
            ['http', 'HTTP endpoint (multipart POST)'],
            ['s3', 'S3-compatible storage'],
          ]}
          onChange={(provider) => patch({ uploads: { provider } })}
        />
      </Row>
      <Row label="Ask before uploading">
        <Toggle
          value={u.confirmBeforeUpload}
          onChange={(v) => patch({ uploads: { confirmBeforeUpload: v } })}
        />
      </Row>
      {status?.weakOptIn && (
        <>
          <p class="warn">
            No keyring service was found, so credentials can only be obfuscated on disk, not
            encrypted. Install gnome-keyring or KWallet to encrypt them.
          </p>
          <Row label="Store credentials without a keyring" hint="Obfuscated only">
            <Toggle
              value={u.allowWeakSecretStorage}
              testId="weak-secrets"
              onChange={(v) => patch({ uploads: { allowWeakSecretStorage: v } })}
            />
          </Row>
        </>
      )}
      {status && !status.available && !status.weakOptIn && (
        <p class="warn">No system keychain is available, so credentials can't be stored.</p>
      )}
      {u.provider === 'http' && (
        <>
          <Row label="Upload URL">
            <Text
              value={u.http.url}
              placeholder="https://example.com/upload"
              onChange={(url) => patch({ uploads: { http: { url } } })}
            />
          </Row>
          <Row label="File field">
            <Text
              value={u.http.fileField}
              onChange={(fileField) => patch({ uploads: { http: { fileField } } })}
            />
          </Row>
          <Row label="URL in response" hint="JSON path, e.g. data.url">
            <Text
              value={u.http.responseUrlPath}
              onChange={(responseUrlPath) => patch({ uploads: { http: { responseUrlPath } } })}
            />
          </Row>
          <Row
            label="Authorization header"
            hint={has('httpAuthorization') ? 'Stored in the system keychain' : 'Optional'}
          >
            <Secret
              stored={has('httpAuthorization')}
              placeholder="Bearer …"
              onChange={(v) => void setSecret('httpAuthorization', v)}
            />
          </Row>
        </>
      )}
      {u.provider === 's3' && (
        <>
          <Row label="Endpoint">
            <Text
              value={u.s3.endpoint}
              placeholder="https://<account>.r2.cloudflarestorage.com"
              onChange={(endpoint) => patch({ uploads: { s3: { endpoint } } })}
            />
          </Row>
          <Row label="Region">
            <Text
              value={u.s3.region}
              onChange={(region) => patch({ uploads: { s3: { region } } })}
            />
          </Row>
          <Row label="Bucket">
            <Text
              value={u.s3.bucket}
              onChange={(bucket) => patch({ uploads: { s3: { bucket } } })}
            />
          </Row>
          <Row label="Access key">
            <Secret
              stored={has('s3AccessKeyId')}
              placeholder=""
              onChange={(v) => void setSecret('s3AccessKeyId', v)}
            />
          </Row>
          <Row label="Secret key">
            <Secret
              stored={has('s3SecretAccessKey')}
              placeholder=""
              onChange={(v) => void setSecret('s3SecretAccessKey', v)}
            />
          </Row>
          <Row label="Public URL" hint="Base of the copied link; empty uses the endpoint">
            <Text
              value={u.s3.publicUrlBase}
              onChange={(publicUrlBase) => patch({ uploads: { s3: { publicUrlBase } } })}
            />
          </Row>
          <Row
            label="Path prefix"
            hint={`e.g. ${expandTemplate(u.s3.pathPrefix || 'anyshot', new Date())}/…`}
          >
            <Text
              value={u.s3.pathPrefix}
              onChange={(pathPrefix) => patch({ uploads: { s3: { pathPrefix } } })}
            />
          </Row>
          <Row label="Public-read ACL" hint="Needed for AWS S3, Spaces, MinIO, B2; not for R2">
            <Toggle
              value={u.s3.publicRead}
              onChange={(publicRead) => patch({ uploads: { s3: { publicRead } } })}
            />
          </Row>
        </>
      )}
      {u.provider !== 'none' && (
        <Row label="Test" group>
          <button
            type="button"
            onClick={async () => {
              setTest('Uploading a 1×1 test image…');
              const r = await api.invoke('uploads:test');
              setTest(r.ok ? `Works: ${r.url}` : `Failed: ${r.error}`);
            }}
          >
            Test connection
          </button>
        </Row>
      )}
      {test && <p class="note">{test}</p>}
    </>
  );
}

function Page({
  tab,
  s,
  hotkeyReport,
}: {
  tab: Tab;
  s: Settings;
  hotkeyReport: HotkeyReport | null;
}) {
  const c = s.capture;
  const o = s.output;
  switch (tab) {
    case 'general':
      return (
        <>
          <Row label="Launch at login">
            <Toggle
              value={s.general.launchAtLogin}
              onChange={(v) => patch({ general: { launchAtLogin: v } })}
            />
          </Row>
          <Row label="Check for updates" hint="Looks for a new release at startup">
            <Toggle
              value={s.general.checkForUpdates}
              testId="check-updates"
              onChange={(v) => patch({ general: { checkForUpdates: v } })}
            />
          </Row>
          <Row label="Appearance" hint="Windows and toolbars" group>
            <Segmented
              label="Appearance"
              value={s.general.toolbarTheme}
              options={THEMES}
              onChange={(toolbarTheme) => patch({ general: { toolbarTheme } })}
              testId="theme"
            />
          </Row>
          <Row label="Accent colour">
            <input
              type="color"
              value={s.general.accent}
              onChange={(e) => patch({ general: { accent: (e.target as HTMLInputElement).value } })}
            />
          </Row>
        </>
      );
    case 'capture':
      return (
        <>
          <Row label="Enter / quick capture">
            <Select
              value={c.quickAction}
              options={[
                ['copy', 'Copy to clipboard'],
                ['save', 'Save to file'],
                ['copy+save', 'Save and copy'],
                ['save+copyPath', 'Save and copy the path'],
                ['none', 'Do nothing'],
              ]}
              onChange={(quickAction) => patch({ capture: { quickAction } })}
            />
          </Row>
          <Row
            label="Instant preview"
            hint="Edit the selection right away. Off: capture at once, then use Edit on the thumbnail"
          >
            <Toggle
              value={c.instantPreview}
              onChange={(v) => patch({ capture: { instantPreview: v } })}
              testId="instant-preview"
            />
          </Row>
          <Row label="Also open in the editor after quick capture">
            <Toggle
              value={c.openEditorAfterQuick}
              onChange={(v) => patch({ capture: { openEditorAfterQuick: v } })}
            />
          </Row>
          <ScreenshotBeautify value={c.beautify} />
          <Row
            label="Instant capture"
            hint="Keeps one hidden overlay ready: faster, costs one renderer of memory"
          >
            <Toggle
              value={c.instantCapture}
              onChange={(v) => patch({ capture: { instantCapture: v } })}
              testId="instant-capture"
            />
          </Row>
          <Row label="Double-click selection to copy">
            <Toggle
              value={c.doubleClickToCopy}
              onChange={(v) => patch({ capture: { doubleClickToCopy: v } })}
            />
          </Row>
          <Row label="Dim outside the selection">
            <Toggle value={c.dimOutside} onChange={(v) => patch({ capture: { dimOutside: v } })} />
          </Row>
          <Row label="Hide capture instructions">
            <Toggle
              value={c.hideInstructions}
              onChange={(v) => patch({ capture: { hideInstructions: v } })}
            />
          </Row>
          <Row label="Remember the last tool">
            <Toggle
              value={c.rememberLastTool}
              onChange={(v) => patch({ capture: { rememberLastTool: v } })}
            />
          </Row>
          <Row label="Floating preview after capture">
            <Toggle
              value={c.showThumbnail}
              onChange={(v) => patch({ capture: { showThumbnail: v } })}
            />
          </Row>
          <Row label="Preview closes after" hint="0 keeps it until closed">
            <NumberField
              value={c.thumbnailDismissSeconds}
              min={0}
              max={60}
              suffix="s"
              onChange={(v) => patch({ capture: { thumbnailDismissSeconds: v } })}
            />
          </Row>
          <Row label="Preview corner">
            <Select
              value={c.thumbnailCorner}
              options={[
                ['bottom-right', 'Bottom right'],
                ['bottom-left', 'Bottom left'],
                ['top-right', 'Top right'],
                ['top-left', 'Top left'],
              ]}
              onChange={(thumbnailCorner) => patch({ capture: { thumbnailCorner } })}
            />
          </Row>
          <Row label="Several previews">
            <Select
              value={c.thumbnailStacking}
              options={[
                ['stack', 'Stack them'],
                ['replace', 'Show only the latest'],
              ]}
              onChange={(thumbnailStacking) => patch({ capture: { thumbnailStacking } })}
            />
          </Row>
          <Row label="Pins appear">
            <Select
              value={c.pinPlacement}
              options={[
                ['original', 'Where the capture was taken'],
                ['center', 'In the centre of the screen'],
              ]}
              onChange={(pinPlacement) => patch({ capture: { pinPlacement } })}
            />
          </Row>
          <Row label="Text capture (OCR)">
            <Select
              value={c.ocrAction}
              options={[
                ['window+copy', 'Show window and copy'],
                ['window', 'Show window only'],
                ['copy', 'Copy only'],
              ]}
              onChange={(ocrAction) => patch({ capture: { ocrAction } })}
            />
          </Row>
        </>
      );
    case 'output':
      return (
        <>
          <Row label="Save">
            <Select
              value={o.saveAction}
              options={[
                ['default-folder', 'To the folder below'],
                ['ask', 'Ask where to save'],
              ]}
              onChange={(saveAction) => patch({ output: { saveAction } })}
            />
          </Row>
          <Row label="Folder" group>
            <Folder value={o.saveDir} fallback="Pictures/anyshot" which="output" />
          </Row>
          <Row
            label="File name"
            hint={`${expandTemplate(o.filenameTemplate, new Date())}.${o.imageFormat === 'jpeg' ? 'jpg' : o.imageFormat}`}
          >
            <Text
              value={o.filenameTemplate}
              onChange={(filenameTemplate) => patch({ output: { filenameTemplate } })}
            />
          </Row>
          <p class="note">
            Tokens:{' '}
            {'{date} {time} {timestamp} {unix} {yyyy} {MM} {dd} {HH} {mm} {ss} {ms} {random}'}; a /
            makes sub-folders.
          </p>
          <Row label="Format">
            <Select
              value={o.imageFormat}
              options={[
                ['png', 'PNG'],
                ['jpeg', 'JPEG'],
                ['webp', 'WebP'],
              ]}
              onChange={(imageFormat) => patch({ output: { imageFormat } })}
            />
          </Row>
          {o.imageFormat !== 'png' && (
            <Row label="Quality">
              <NumberField
                value={o.imageQuality}
                min={10}
                max={100}
                suffix="%"
                onChange={(v) => patch({ output: { imageQuality: v } })}
              />
            </Row>
          )}
          <Row label="Copy the path after saving">
            <Toggle
              value={o.copyPathAfterSave}
              onChange={(v) => patch({ output: { copyPathAfterSave: v } })}
            />
          </Row>
          <Row label="History size" hint="0 turns history off">
            <NumberField
              value={o.historySize}
              min={0}
              max={1000}
              onChange={(v) => patch({ output: { historySize: v } })}
            />
          </Row>
        </>
      );
    case 'shortcuts': {
      const failedByAction = new Map((hotkeyReport?.failed ?? []).map((f) => [f.action, f]));
      const unconfirmed = new Set(hotkeyReport?.unconfirmed ?? []);
      return (
        <>
          <p class="note">
            Click a shortcut, then press the new keys. If a shortcut does nothing, another app may
            already use it. On Wayland, bind commands such as <code>anyshot --capture</code> in your
            desktop's keyboard settings instead.
          </p>
          {HOTKEY_ACTIONS.map((action) => {
            const failure = failedByAction.get(action);
            const isUnconfirmed = !failure && unconfirmed.has(action);
            const statusId = failure || isUnconfirmed ? `hotkey-warn-${action}` : undefined;
            return (
              <Row key={action} label={HOTKEY_LABELS[action]} group>
                <div class="shortcut-wrap">
                  <Shortcut
                    action={action}
                    value={s.hotkeys[action]}
                    invalid={Boolean(failure)}
                    describedBy={statusId}
                  />
                  {failure && (
                    <small
                      id={statusId}
                      class="shortcut-warn"
                      role="status"
                      data-testid={`hotkey-warn-${action}`}
                    >
                      {failure.conflictWith
                        ? `Conflicts with ${HOTKEY_LABELS[failure.conflictWith]}`
                        : 'Could not register this shortcut'}
                    </small>
                  )}
                  {isUnconfirmed && (
                    <small
                      id={statusId}
                      class="shortcut-note"
                      role="status"
                      data-testid={`hotkey-note-${action}`}
                    >
                      Submitted to Wayland portal; confirmation is unavailable
                    </small>
                  )}
                </div>
              </Row>
            );
          })}
        </>
      );
    }
    case 'tools':
      return (
        <>
          <div class="page-head">
            <p class="note">Tools shown in the toolbar. Hidden tools still work with their keys.</p>
            <ResetTools />
          </div>
          <div class="tools">
            {TOOL_IDS.map((tool) => (
              <label key={tool}>
                <input
                  type="checkbox"
                  checked={s.tools.enabledTools.includes(tool)}
                  onChange={(e) => {
                    submitSettings(
                      api.invoke('settings:set-tool-enabled', {
                        tool,
                        enabled: e.currentTarget.checked,
                      }),
                    );
                  }}
                />
                {TOOL_LABELS[tool]}
              </label>
            ))}
          </div>
        </>
      );
    case 'recording':
      return (
        <>
          <Row label="Frame rate">
            <Select
              value={String(s.recording.fps) as '15' | '24' | '30' | '60'}
              options={[
                ['15', '15 fps'],
                ['24', '24 fps'],
                ['30', '30 fps'],
                ['60', '60 fps'],
              ]}
              onChange={(v) => patch({ recording: { fps: Number(v) } })}
            />
          </Row>
          <Row
            label="Video quality"
            hint="The largest resolution a recording is saved at; smaller areas keep their size. Higher settings keep more detail and make larger files."
          >
            <Select
              value={s.recording.quality}
              options={RECORDING_QUALITY_OPTIONS}
              onChange={(quality) => patch({ recording: { quality } })}
            />
          </Row>
          <Row
            label="Record computer audio"
            hint="Windows only. Also toggled on the record bar (A)"
          >
            <Toggle
              value={s.recording.systemAudio}
              onChange={(v) => patch({ recording: { systemAudio: v } })}
            />
          </Row>
          <Row label="Record microphone" hint="Also toggled on the record bar (M)">
            <Toggle
              value={s.recording.microphone}
              onChange={(v) => patch({ recording: { microphone: v } })}
            />
          </Row>
          <Row label="Folder" group>
            <Folder value={s.recording.saveDir} fallback="Videos/anyshot" which="recording" />
          </Row>
          <Row label="File name">
            <Text
              value={s.recording.filenameTemplate}
              onChange={(filenameTemplate) => patch({ recording: { filenameTemplate } })}
            />
          </Row>
          <Row
            label="Show recording controls"
            hint="Time, Pause and Stop beside the area, and a red border around it. When off, use the tray menu"
          >
            <Toggle
              value={s.recording.showControls}
              onChange={(v) => patch({ recording: { showControls: v } })}
              testId="recording-show-controls"
            />
          </Row>
          <Row label="When done">
            <Select
              value={s.recording.whenDone}
              options={[
                ['reveal', 'Show in folder'],
                ['open', 'Open the video'],
                ['copyPath', 'Copy the path'],
              ]}
              onChange={(whenDone) => patch({ recording: { whenDone } })}
            />
          </Row>
          <Row label="Scroll capture height limit">
            <NumberField
              value={s.scroll.maxHeight}
              min={1000}
              max={100000}
              step={1000}
              suffix="px"
              onChange={(v) => patch({ scroll: { maxHeight: v } })}
            />
          </Row>
        </>
      );
    case 'uploads':
      return <Uploads s={s} />;
    case 'about':
      return (
        <div class="about">
          <img class="logo" src={logo} alt="" width={72} height={72} />
          <h2>anyshot</h2>
          <p>A lean screenshot, annotation and screen-recording app for Windows and Linux.</p>
          <p>
            Released under the MIT licence. Feature ideas come from{' '}
            <button
              type="button"
              class="link"
              onClick={() =>
                void api.invoke('shell:open-url', 'https://github.com/sw33tLie/macshot')
              }
            >
              macshot
            </button>
            ; anyshot shares no code or artwork with it.
          </p>
        </div>
      );
  }
}

function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [hotkeyReport, setHotkeyReport] = useState<HotkeyReport | null>(null);
  const [tab, setTab] = useState<Tab>('general');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.invoke('settings:get').then((s) => {
      setSettings(s);
      applyTheme(s);
    });
    void api.invoke('hotkeys:status').then(setHotkeyReport);
    const offSettings = api.on('settings:changed', (s) => {
      setSettings(s);
      applyTheme(s);
    });
    const offHotkeys = api.on('hotkeys:changed', setHotkeyReport);
    return () => {
      offSettings();
      offHotkeys();
    };
  }, []);
  submitSettings = (request) => {
    setError(null);
    void request.catch((failure: unknown) =>
      setError(`Could not save settings. ${String(failure)}`),
    );
  };
  patch = (p) => submitSettings(api.invoke('settings:patch', p));
  if (!settings) return null;
  return (
    <div class="settings">
      <nav>
        {TABS.map((t) => (
          <button
            type="button"
            key={t.id}
            class={t.id === tab ? 'active' : ''}
            onClick={() => setTab(t.id)}
            data-testid={`tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <section>
        <h1>{TABS.find((t) => t.id === tab)?.label}</h1>
        {error && (
          <p class="warn" role="alert">
            {error}
          </p>
        )}
        <Page tab={tab} s={settings} hotkeyReport={hotkeyReport} />
      </section>
    </div>
  );
}

render(<App />, document.getElementById('root') as HTMLElement);
