import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState } from '../shared/domain';
import { readState, request } from './api';
import { shareAppState } from './stateSharing';
import {StateStreamReceiver,newerState} from '../shared/state-stream';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline';
export function useTerminal() {
  const [state, setState] = useState<AppState | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(0);
  const current = useRef<AppState | null>(null);
  const busyKeys = useRef(new Set<string>());
  const mounted = useRef(true);
  const generations = useRef(new Set<string>());
  const readEpoch=useRef(0);
  const receive = useCallback((next: AppState) => {
    if (!mounted.current) return;
    const previous = current.current;
    if(!newerState(previous,next,generations.current))return;
    generations.current.add(next.csrf);
    const shared = shareAppState(previous, next); current.current = shared; setState(shared);
  }, []);
  const refresh = useCallback(async () => {
    const epoch=readEpoch.current;
    try { const next=await readState();if(epoch!==readEpoch.current)return;receive(next);setReadError(''); }
    catch (e) { if (mounted.current&&epoch===readEpoch.current) setReadError(e instanceof Error ? e.message : '无法连接本机服务。'); }
  }, [receive]);
  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    const initialEpoch=readEpoch.current;
    void readState(abort.signal).then(next => {if(initialEpoch!==readEpoch.current)return;receive(next);setReadError('');}).catch(e=>{if(!abort.signal.aborted&&initialEpoch===readEpoch.current){setReadError(e.message);setConnection('offline');}});
    let events:EventSource|null=null, retry:ReturnType<typeof setTimeout>|null=null, lastEvent=0;
    const connect = () => {
      if(abort.signal.aborted)return;
      const receiver=new StateStreamReceiver(), source=new EventSource('/api/events?delta=1');events=source;
      source.onopen=()=>{if(mounted.current){lastEvent=performance.now();setConnection('live');}};
      const onState=(event:MessageEvent)=>{
        if(abort.signal.aborted||events!==source)return;
        try{const next=receiver.accept(JSON.parse(event.data));lastEvent=performance.now();receive(next);setConnection('live');setReadError('');}
        catch{setReadError('状态同步中断，正在重新获取完整状态。');setConnection('reconnecting');source.close();if(retry)clearTimeout(retry);retry=setTimeout(()=>{retry=null;connect();},1000);void refresh();}
      };
      source.onmessage=onState;source.addEventListener('state',onState);
      source.onerror=()=>{if(mounted.current)setConnection(current.current?'reconnecting':'offline');};
    };
    connect();
    // Healthy event streams already carry current state. Poll only as a
    // fallback, instead of downloading the entire ledger every 15 seconds.
    const timer=setInterval(()=>{if(performance.now()-lastEvent>20000)void refresh();},15000);
    const invalidate=()=>{readEpoch.current++;current.current=null;events?.close();if(retry){clearTimeout(retry);retry=null;}connect();};
    window.addEventListener('paper-restored', invalidate);
    return () => { mounted.current=false;abort.abort();events?.close();if(retry)clearTimeout(retry);clearInterval(timer);window.removeEventListener('paper-restored',invalidate); };
  }, [receive, refresh]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6500); return () => clearTimeout(timer); }, [notice]);
  const mutate = useCallback(async (path: string, body: unknown, success?: string) => {
    if (!current.current) { setError('本机服务尚未连接。'); return false; }
    const key = path + JSON.stringify(body);
    if (busyKeys.current.has(key)) return false;
    busyKeys.current.add(key); setPending(n => n + 1); setError('');
    try { await request(path, current.current.csrf, body); if (success) setNotice(success); await refresh(); return true; }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败。'); return false; }
    finally { busyKeys.current.delete(key); if (mounted.current) setPending(n => n - 1); }
  }, [refresh]);
  const reportError = useCallback((value: string) => { setError(value); if (!value) setReadError(''); }, []);
  const controls = useMemo(() => ({ error: error || readError, pending: pending > 0, mutate, setError: reportError, setNotice }), [error, readError, pending, mutate, reportError]);
  return { state, connection, error: error || readError, notice, pending: pending > 0, refresh, mutate, setError: reportError, setNotice, controls };
}
export type TerminalActions = ReturnType<typeof useTerminal>;
export type TerminalControls = TerminalActions['controls'];
