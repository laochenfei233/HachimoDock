import React,{useEffect,useMemo,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {MoonStar} from 'lucide-react';
import Button from '../shell/Button';
import {createDeviceAodController,EMPTY_AOD_STATE,AOD_ITEM_OPTIONS,AOD_ITEM_LABELS,AOD_TIMEOUT_OPTIONS} from './aod-controller.js';
import {useExitProtection} from '../lib/exit-protection.js';
import './device-aod.css';

export default function DeviceAodPanel({usb,active=true}) {
  const [state,setState]=useState({...EMPTY_AOD_STATE});
  const control=useMemo(()=>createDeviceAodController({invoke,onState:setState}),[]);
  const engine=usb?.capabilities?.displayAod;
  useEffect(()=>{void control.setTarget({connected:usb?.connected,boardDeviceId:usb?.boardDeviceId,bootId:usb?.bootId,connectionId:usb?.connectionId,runtime:usb?.runtime,engine});},
    [control,usb?.connectionId,usb?.connected,usb?.boardDeviceId,usb?.bootId,usb?.runtime,engine]);
  useEffect(()=>()=>control.dispose(),[control]);
  useExitProtection(state.busy ? "设备息屏配置请求尚未完成" : "");
  const disabled=!state.available||state.busy;
  const items=state.known&&state.items?state.items:['time','date'];
  const slotValue=index=>items[index]??'none';
  const changeSlot=(index,value)=>{
    const next=[slotValue(0),slotValue(1)];
    next[index]=value;
    void control.configure(state.timeout??5,next);
  };
  return <div className="device-aod">
    <div className="device-aod__row">
      <label htmlFor="aod-timeout">空闲后息屏</label>
      <select id="aod-timeout" value={state.timeout??5} disabled={disabled}
        onChange={event=>void control.configure(Number(event.target.value),[slotValue(0),slotValue(1)])}>
        {AOD_TIMEOUT_OPTIONS.map(minutes=><option key={minutes} value={minutes}>{minutes===0?'从不息屏':`${minutes} 分钟`}</option>)}
      </select>
    </div>
    <div className="device-aod__row">
      <label htmlFor="aod-item-0">灵动岛显示</label>
      <div className="device-aod__items">
        {[0,1].map(index=><select key={index} id={index===0?'aod-item-0':undefined} aria-label={index===0?'第一显示项':'第二显示项'}
          value={slotValue(index)} disabled={disabled} onChange={event=>changeSlot(index,event.target.value)}>
          {AOD_ITEM_OPTIONS.map(name=><option key={name} value={name}>{AOD_ITEM_LABELS[name]}</option>)}
        </select>)}
      </div>
    </div>
    <div className="device-aod__presets">
      <Button variant="ghost" size="small" disabled={disabled} onClick={()=>{void control.enter();}}>
        <MoonStar size={14}/>立即息屏
      </Button>
      <Button variant="ghost" size="small" disabled={disabled} onClick={()=>{void control.refresh();}}>读取设备配置</Button>
    </div>
    <p className="device-aod__message" role={state.error?'alert':undefined}>
      {state.error || (!state.available ? state.reason : state.busy ? '正在与设备同步…'
        : !state.known ? '尚未读取设备配置' : state.active ? '息屏页已激活，任意触摸或按键唤醒。' : state.persisted ? '配置已保存到设备；空闲超过设定时长后息屏。' : '配置已应用，但设备未确认保存。')}
    </p>
  </div>;
}
