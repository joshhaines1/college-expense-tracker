import { useState } from 'react';
import type { ScanResponse } from './api';
import { localToday, validate, type FormValues } from './format';

interface Props {
  previewUrl: string;
  scan: ScanResponse;
  values: FormValues;
  onChange: (v: FormValues) => void;
  onSubmit: () => void;
  onCancel: () => void;
  saving: boolean;
  saveError: string | null;
}

export function ReviewForm({ previewUrl, scan, values, onChange, onSubmit, onCancel, saving, saveError }: Props) {
  const [touched, setTouched] = useState<{ date: boolean; amount: boolean }>({ date: false, amount: false });
  const errors = validate(values);
  const invalid = Boolean(errors.date || errors.amount);
  // Highlight fields OCR was unsure about (or missed) until the user edits them.
  const dateFlag = scan.dateStatus !== 'ok' && !touched.date;
  const amountFlag = scan.totalStatus !== 'ok' && !touched.amount;
  const set = (patch: Partial<FormValues>) => onChange({ ...values, ...patch });

  return (
    <form
      className="card"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setTouched({ date: true, amount: true });
        if (!invalid && !saving) onSubmit();
      }}
    >
      <img className="preview" src={previewUrl} alt="Receipt preview" />

      {scan.warnings.length > 0 && (
        <ul className="warnings" role="status">
          {scan.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <p className="hint">Check the details below. Nothing is saved until you tap Save.</p>

      <label className={`field ${dateFlag ? 'flag' : ''} ${touched.date && errors.date ? 'error' : ''}`}>
        <span>Purchase date{dateFlag && <em> — please check</em>}</span>
        <input
          type="date"
          value={values.date}
          max={localToday()}
          required
          onChange={(e) => {
            setTouched((t) => ({ ...t, date: true }));
            set({ date: e.target.value });
          }}
        />
        {touched.date && errors.date && <small>{errors.date}</small>}
      </label>

      <label className={`field ${amountFlag ? 'flag' : ''} ${touched.amount && errors.amount ? 'error' : ''}`}>
        <span>Total charged ($){amountFlag && <em> — please check</em>}</span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={values.amount}
          required
          onChange={(e) => {
            setTouched((t) => ({ ...t, amount: true }));
            set({ amount: e.target.value });
          }}
        />
        {touched.amount && errors.amount && <small>{errors.amount}</small>}
      </label>

      <label className="field">
        <span>Category</span>
        <input type="text" value="Groceries" readOnly aria-readonly="true" />
      </label>

      <label className="field">
        <span>Description (optional)</span>
        <input type="text" maxLength={200} value={values.description} onChange={(e) => set({ description: e.target.value })} />
      </label>

      <label className="field">
        <span>Notes (optional)</span>
        <textarea rows={3} maxLength={500} value={values.notes} onChange={(e) => set({ notes: e.target.value })} />
      </label>

      {scan.rawText && (
        <details className="raw">
          <summary>Show text read from receipt</summary>
          <pre>{scan.rawText}</pre>
        </details>
      )}

      {saveError && (
        <p className="alert" role="alert">
          {saveError}
        </p>
      )}

      <div className="actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save to spreadsheet'}
        </button>
        <button type="button" className="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
      <p className="hint small">The receipt photo is stored in your Google Drive and viewable by anyone who has its link.</p>
    </form>
  );
}
