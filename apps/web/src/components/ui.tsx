import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Issue } from '../lib/types';
import type { Lamp as LampState } from '../lib/presentation';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'quiet'; size?: 'small' };

export const Button = ({ variant = 'secondary', size, className = '', type = 'button', ...rest }: ButtonProps) => (
  <button
    type={type}
    className={['btn', variant === 'secondary' ? '' : `btn-${variant}`, size ? `btn-${size}` : '', className].filter(Boolean).join(' ')}
    {...rest}
  />
);

type FieldProps = {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined }) => ReactNode;
};

/** Label, control, hint and error wired together for screen readers. */
export const Field = ({ label, hint, error, children }: FieldProps) => {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>
        <span className="label">{label}</span>
      </label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy })}
      {hint ? <small id={hintId}>{hint}</small> : null}
      {error ? (
        <span id={errorId} className="error">
          {error}
        </span>
      ) : null}
    </div>
  );
};

export const Lamp = ({ lamp }: { lamp: LampState }) => (
  <span className="lamp" data-tone={lamp.tone}>
    {lamp.label}
  </span>
);

export const Empty = ({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) => (
  <div className="empty">
    <h2>{title}</h2>
    {children ? <p>{children}</p> : null}
    {actions ? <div className="actions">{actions}</div> : null}
  </div>
);

export const Loading = ({ label = 'Loading' }: { label?: string }) => (
  <p className="loading" role="status">
    {label}…
  </p>
);

export const ErrorNotice = ({ error, onRetry }: { error: Error; onRetry?: () => void }) => (
  <div className="notice" role="alert">
    <p>{error.message}</p>
    {onRetry ? (
      <div className="actions">
        <Button size="small" onClick={onRetry}>
          Try again
        </Button>
      </div>
    ) : null}
  </div>
);

export const IssueList = ({ issues, title }: { issues: readonly Issue[]; title?: string }) =>
  issues.length === 0 ? null : (
    <div role="alert">
      {title ? <p className="error-text">{title}</p> : null}
      <ul className="issues">
        {issues.map((issue, index) => (
          <li key={`${issue.path}-${index}`}>{issue.message}</li>
        ))}
      </ul>
    </div>
  );

type DialogProps = { open: boolean; title: string; onClose: () => void; children: ReactNode; actions: ReactNode };

/** Native <dialog>: focus is trapped, Escape closes, the page behind is inert. */
export const Dialog = ({ open, title, onClose, children, actions }: DialogProps) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
      {open ? (
        <div className="dialog-body">
          <h2 id={titleId}>{title}</h2>
          {children}
          <div className="actions">{actions}</div>
        </div>
      ) : null}
    </dialog>
  );
};

export const JsonBlock = ({ value }: { value: unknown }) => (
  <pre className="json">
    <code>{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</code>
  </pre>
);

/** Shown only when the browser offers to install the app (Chrome on Android and desktop). */
export const InstallButton = ({ available, onInstall, className }: { available: boolean; onInstall: () => void; className?: string }) =>
  available ? (
    <button type="button" className={['install-button', className].filter(Boolean).join(' ')} onClick={onInstall}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
      </svg>
      Install app
    </button>
  ) : null;
