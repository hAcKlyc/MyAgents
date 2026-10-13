import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stopBotChild } from '../host/bot-child-stop';

const children: ChildProcess[]=[];
afterEach(async()=>{
  for(const child of children.splice(0)) {
    if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
    if(child.exitCode===null && child.signalCode===null) await new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  }
});

async function waitForReady(child:ChildProcess,ready:()=>boolean):Promise<void>{
  if(ready()) return;
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error('child readiness timeout')),5_000);
    const onExit=()=>finish(new Error('child exited before ready'));
    const check=()=>{if(ready())finish();};
    const finish=(error?:Error)=>{
      clearTimeout(timer);child.off('exit',onExit);child.stdout?.off('data',check);
      if(error)reject(error);else resolve();
    };
    child.once('exit',onExit);child.stdout?.on('data',check);check();
  });
}

describe('stopBotChild',()=>{
  it('rejects unbounded stage deadlines before invoking shutdown',async()=>{
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore']});
    children.push(child);
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    const shutdown=vi.fn(async()=>undefined);
    await expect(stopBotChild(child,shutdown,{graceMs:60_001,termMs:10,killMs:10})).rejects.toThrow('BOT_STOP_DEADLINE_INVALID');
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('accepts shutdown only after observing the exact child exit and removes its listeners',async()=>{
    const child=spawn(process.execPath,['-e',`process.on('message',message=>{if(message==='shutdown')process.exit(0)});process.stdout.write('ready\\n')`],
      {stdio:['ignore','pipe','pipe','ipc']});
    children.push(child);
    let output='';child.stdout?.on('data',chunk=>{output+=String(chunk);});
    await waitForReady(child,()=>output.includes('ready'));
    const before=child.listenerCount('exit');
    await stopBotChild(child,()=>new Promise<void>((resolve,reject)=>child.send('shutdown',error=>error?reject(error):resolve())),
      {graceMs:500,termMs:100,killMs:100});
    expect(child.exitCode).toBe(0);
    expect(child.listenerCount('exit')).toBe(before);
  });

  it('escalates from shutdown to SIGTERM and SIGKILL, then waits for real exit',async()=>{
    const child=spawn(process.execPath,['-e',`process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setInterval(()=>{},1000)`],
      {stdio:['ignore','pipe','pipe']});
    children.push(child);
    let output='';child.stdout?.on('data',chunk=>{output+=String(chunk);});
    await waitForReady(child,()=>output.includes('ready'));
    const signals:string[]=[];const originalKill=child.kill.bind(child);
    vi.spyOn(child,'kill').mockImplementation(((signal?:NodeJS.Signals)=>{
      signals.push(signal??'SIGTERM');return originalKill(signal);
    }) as typeof child.kill);
    await stopBotChild(child,async()=>undefined,{graceMs:30,termMs:30,killMs:1_000});
    expect(signals).toEqual(['SIGTERM','SIGKILL']);
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('does not claim stopped when signals yield no ChildProcess exit evidence',async()=>{
    const child=spawn(process.execPath,['-e',`process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`],{stdio:['ignore','ignore','ignore']});
    children.push(child);
    await new Promise<void>((resolve,reject)=>{
      child.once('spawn',resolve);child.once('error',reject);
    });
    const kill=vi.spyOn(child,'kill').mockReturnValue(false);
    await expect(stopBotChild(child,async()=>undefined,{graceMs:10,termMs:10,killMs:10})).rejects.toThrow('BOT_EXIT_UNCONFIRMED');
    expect(kill).toHaveBeenCalledTimes(2);
    kill.mockRestore();
    child.kill('SIGKILL');
  });
});
