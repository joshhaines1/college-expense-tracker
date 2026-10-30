import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, saveExpense, scanReceipt, type SaveResponse, type ScanResponse } from './api';
import { formatMoney, newIdempotencyKey, normalizeAmount, type FormValues } from './format';
import { ACCEPT, prepareImage } from './image';
import { ReviewForm } from './ReviewForm';

type Phase = 'pick' | 'scanning' | 'review' | 'saved';
const EMPTY: FormValues = { date: '', amount: '', description: '', notes: '' };

export function App() {
  const [phase, setPhase] = useState<Phase>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResponse | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const keyRef = useRef(newIdempotencyKey());
  const savingRef = useRef(false); // guards double taps before React re-renders the disabled button
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const reset = useCallback(() => {
    setPhase('pick');
    setFile(null);
    setPreviewUrl('');
    setScan(null);
    setValues(EMPTY);
    setError(null);
    setSaveError(null);
    setResult(null);
    keyRef.current = newIdempotencyKey();
  }, []);

  async function onFile(picked: File | undefined) {
    if (!picked) return;
    setError(null);
    setSaveError(null);
    setPhase('scanning');
    try {
      const img = await prepareImage(picked);
      setFile(img);
      setPreviewUrl(URL.createObjectURL(img));
      keyRef.current = newIdempotencyKey(); // a new photo is a new submission
      let s: ScanResponse;
      try {
        s = await scanReceipt(img);
      } catch (e) {
        // OCR failure is not fatal: let the user type the values from the preview.
        const msg = e instanceof ApiError ? e.message : 'The receipt could not be read.';
        s = { date: null, total: null, dateStatus: 'missing', totalStatus: 'missing', warnings: [`${msg} You can enter the details by hand.`], rawText: '' };
      }
      setScan(s);
      setValues({ date: s.date ?? '', amount: s.total != null ? s.total.toFixed(2) : '', description: '', notes: '' });
      setPhase('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that photo.');
      setPhase('pick');
    }
  }

  async function onSave() {
    const amount = normalizeAmount(values.amount);
    if (!file || !amount || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await saveExpense({ image: file, idempotencyKey: keyRef.current, date: values.date, amount, description: values.description, notes: values.notes });
      setResult(r);
      setPhase('saved');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Saving failed.';
      setSaveError(e instanceof ApiError && e.retryable ? `${msg} Your entries are kept — tap Save to retry; it will not create a duplicate.` : msg);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <main>
      <header>
        <h1>Expense Tracker</h1>
        <p className="sub">Grocery receipts → Google Sheets</p>
      </header>
      {!online && (
        <p className="alert" role="alert">
          You're offline. Reconnect to scan or save.
        </p>
      )}

      {phase === 'pick' && (
        <section className="card center">
          {error && (
            <p className="alert" role="alert">
              {error}
            </p>
          )}
          <p>Photograph a grocery receipt on a flat surface, with the whole receipt in frame.</p>
          <div className="actions">
            <button className="primary" onClick={() => camera.current?.click()}>
              Take photo
            </button>
            <button className="secondary" onClick={() => library.current?.click()}>
              Choose from library
            </button>
          </div>
          <input ref={camera} type="file" accept={ACCEPT} capture="environment" hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
          <input ref={library} type="file" accept={ACCEPT} hidden onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </section>
      )}

      {phase === 'scanning' && (
        <section className="card center" aria-busy="true">
          {previewUrl && <img className="preview" src={previewUrl} alt="Receipt preview" />}
          <div className="spinner" aria-hidden="true" />
          <p>Reading receipt… this can take 10–20 seconds.</p>
        </section>
      )}

      {phase === 'review' && scan && (
        <ReviewForm previewUrl={previewUrl} scan={scan} values={values} onChange={setValues} onSubmit={() => void onSave()} onCancel={reset} saving={saving} saveError={saveError} />
      )}

      {phase === 'saved' && result && (
        <section className="card center">
          <div className="check" aria-hidden="true">✓</div>
          <h2>Saved {formatMoney(result.amount)}</h2>
          <p>
            {result.duplicate ? 'This receipt was already saved earlier — no duplicate was created. ' : ''}
            Added to Sheet1, row {result.row}, as Groceries on {result.date}.
          </p>
          <a className="secondary linkbtn" href={result.receiptUrl} target="_blank" rel="noopener noreferrer">
            View stored receipt
          </a>
          <button className="primary" onClick={reset}>
            Add another receipt
          </button>
        </section>
      )}
    </main>
  );
}
