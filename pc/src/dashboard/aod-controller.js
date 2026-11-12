export const AOD_ENGINE = 'p4-display-aod-v1';
export const AOD_ITEM_OPTIONS = ['none', 'time', 'date', 'weather', 'agent'];
export const AOD_ITEM_LABELS = Object.freeze({none:'无', time:'时间', date:'日期', weather:'天气', agent:'Agent 状态'});
export const AOD_TIMEOUT_OPTIONS = Object.freeze([0, 1, 5, 10, 30]);
export const EMPTY_AOD_STATE = Object.freeze({timeout:null, items:null, known:false, busy:false, persisted:false, active:false, error:'', available:false, reason:'请先连接设备'});
const timeout_ok = v => Number.isInteger(v) && v >= 0 && v <= 1440;

export function createDeviceAodController({invoke,onState=()=>{}}) {
  let state={...EMPTY_AOD_STATE}, target=null, generation=0, disposed=false;
  const publish = patch => {state={...state,...patch};onState({...state});};
  const current = serial => !disposed && serial===generation;
  const valid = (reply,board) => reply?.ok===true && reply.engine===AOD_ENGINE && reply.boardDeviceId===board
    && timeout_ok(reply.timeoutMinutes)
    && Array.isArray(reply.items) && reply.items.length===2 && reply.items.every(name=>AOD_ITEM_OPTIONS.includes(name))
    && typeof reply.persisted==='boolean' && typeof reply.active==='boolean';
  const message = error => typeof error==='string' ? error : error?.message || '设备未返回有效的确认';
  async function request(body) {
    if (!target?.available || state.busy) return false;
    const serial=generation, board=target.boardDeviceId;
    publish({busy:true,error:''});
    try {
      const reply=await invoke('usb_display_aod',{expectedBoardDeviceId:board,...body});
      if (!current(serial)) return false;
      if (!valid(reply,board)) throw Error('设备息屏配置确认不匹配');
      publish({timeout:reply.timeoutMinutes,items:reply.items,known:true,persisted:reply.persisted,active:reply.active,error:''});
      return true;
    } catch(error) {
      if (current(serial)) publish({error: message(error)});
      return false;
    } finally {
      if (current(serial)) publish({busy:false});
    }
  }
  return {
    getSnapshot:()=>({...state}),
    setTarget(value) {
      if (disposed) {disposed=false;target=null;}
      const key=JSON.stringify([value?.connected,value?.boardDeviceId,value?.bootId,value?.connectionId,value?.runtime,value?.engine]);
      if (key===target?.key) return Promise.resolve(false);
      generation++;
      const connected=value?.connected===true && Boolean(value.boardDeviceId);
      const supported=value?.runtime==='esp-p4' && value?.engine===AOD_ENGINE;
      target={key,boardDeviceId:value?.boardDeviceId||'',available:connected&&supported};
      state={...EMPTY_AOD_STATE,available:target.available,reason:!connected?'请先连接设备':supported?'':'更新设备固件后可配置息屏灵动岛'};
      onState({...state});
      return target.available ? request({operation:'query'}) : Promise.resolve(false);
    },
    configure(timeoutMinutes, items) {
      if (!timeout_ok(timeoutMinutes)) {publish({error:'息屏超时须为 0–1440 的整数分钟'});return false;}
      if (items.length>2 || !items.every(n=>AOD_ITEM_OPTIONS.includes(n))) {publish({error:'显示项无效'});return false;}
      if (items.some((n,index)=>n!=='none'&&items.slice(0,index).includes(n))) {publish({error:'两个显示项不能相同'});return false;}
      if (state.known && state.timeout===timeoutMinutes && JSON.stringify(state.items)===JSON.stringify(items) && state.persisted) return true;
      return request({operation:'set',timeoutMinutes,items});
    },
    enter:()=>request({operation:'enter'}),
    refresh:()=>request({operation:'query'}),
    dispose(){disposed=true;generation++;target=null;},
  };
}
