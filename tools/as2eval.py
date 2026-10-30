import struct, json, sys
d=open('swf/poker-clock.uncompressed.swf','rb').read()
def tags(d):
    p=8; nbits=d[p]>>3; p+=(5+4*nbits+7)//8; p+=4
    while p<len(d):
        h=struct.unpack('<H',d[p:p+2])[0]; code=h>>6; ln=h&0x3f; p+=2
        if ln==0x3f: ln=struct.unpack('<I',d[p:p+4])[0]; p+=4
        yield code, d[p:p+ln]; p+=ln
        if code==0: break
acts=[b for c,b in tags(d) if c==12]
code=acts[1]
class U: 
    def __repr__(s): return 'undefined'
UND=U()
G={}
stack=[]; pool=[]; regs=[None]*256
def truthy(v): return not (v is UND or v is None or v==0 or v=='' or v is False)
p=0
while p<len(code):
    op=code[p]; p+=1
    if op>=0x80:
        ln=struct.unpack('<H',code[p:p+2])[0]; p+=2; body=code[p:p+ln]; p+=ln
    else: body=b''
    if op==0x88:
        cnt=struct.unpack('<H',body[:2])[0]; pool=[s.decode('utf8','replace') for s in body[2:].split(b'\0')[:cnt]]
    elif op==0x96:
        q=0
        while q<len(body):
            t=body[q]; q+=1
            if t==0: e=body.index(b'\0',q); stack.append(body[q:e].decode('utf8','replace')); q=e+1
            elif t==1: stack.append(struct.unpack('<f',body[q:q+4])[0]); q+=4
            elif t==2: stack.append(None)
            elif t==3: stack.append(UND)
            elif t==4: stack.append(regs[body[q]]); q+=1
            elif t==5: stack.append(bool(body[q])); q+=1
            elif t==6: stack.append(struct.unpack('<d',body[q+4:q+8]+body[q:q+4])[0]); q+=8
            elif t==7: stack.append(struct.unpack('<i',body[q:q+4])[0]); q+=4
            elif t==8: stack.append(pool[body[q]]); q+=1
            elif t==9: stack.append(pool[struct.unpack('<H',body[q:q+2])[0]]); q+=2
    elif op in (0x9b,0x8e):
        q=body.index(b'\0'); name=body[:q].decode(); q+=1
        n=struct.unpack('<H',body[q:q+2])[0]; q+=2
        if op==0x8e: q+=3
        for _ in range(n): q=body.index(b'\0',q)+1
        clen=struct.unpack('<H',body[q:q+2])[0]
        p+=clen
        if name: G[name]='<fn>'
        else: stack.append('<fn>')
    elif op==0x42:  # InitArray
        n=int(stack.pop()); stack.append([stack.pop() for _ in range(n)])
    elif op==0x43:  # InitObject
        n=int(stack.pop()); o={}
        for _ in range(n): v=stack.pop(); k=stack.pop(); o[k]=v
        stack.append(o)
    elif op==0x1d: v=stack.pop(); k=stack.pop(); G[k]=v
    elif op==0x1c: k=stack.pop(); stack.append(G.get(k,UND))
    elif op==0x4e:
        m=stack.pop(); o=stack.pop()
        if isinstance(o,dict): stack.append(o.get(m,UND))
        elif isinstance(o,list):
            if m=='length': stack.append(len(o))
            else:
                try: stack.append(o[int(m)])
                except: stack.append(UND)
        else: stack.append(UND)
    elif op==0x4f:
        v=stack.pop(); m=stack.pop(); o=stack.pop()
        if isinstance(o,dict): o[m]=v
        elif isinstance(o,list):
            i=int(m)
            while len(o)<=i: o.append(UND)
            o[i]=v
    elif op==0x3d:  # CallFunction
        name=stack.pop(); n=int(stack.pop()); args=[stack.pop() for _ in range(n)]
        if name=='Array': stack.append(args)
        else: stack.append(UND)
    elif op==0x52:  # CallMethod
        name=stack.pop(); o=stack.pop(); n=int(stack.pop()); args=[stack.pop() for _ in range(n)]
        if name=='push' and isinstance(o,list): o.extend(args); stack.append(len(o))
        else: stack.append(UND)
    elif op==0x40:  # NewObject
        name=stack.pop(); n=int(stack.pop()); args=[stack.pop() for _ in range(n)]
        stack.append(args if name=='Array' else {})
    elif op==0x17: stack.pop()
    elif op==0x12: stack.append(not truthy(stack.pop()))
    elif op==0x4c: stack.append(stack[-1])
    elif op==0x87: regs[body[0]]=stack[-1]
    elif op==0x99: p+=struct.unpack('<h',body)[0]
    elif op==0x9d:
        if truthy(stack.pop()): p+=struct.unpack('<h',body)[0]
    elif op==0x49: b=stack.pop(); a=stack.pop(); stack.append(a==b)
    elif op==0x66: b=stack.pop(); a=stack.pop(); stack.append(a==b)
    elif op==0x48: b=stack.pop(); a=stack.pop(); stack.append(a<b if a is not UND and b is not UND else False)
    elif op==0x67: b=stack.pop(); a=stack.pop(); stack.append(a>b if a is not UND and b is not UND else False)
    elif op==0x47: b=stack.pop(); a=stack.pop(); stack.append((str(a)+str(b)) if isinstance(a,str) or isinstance(b,str) else a+b)
    elif op==0x0b: b=stack.pop(); a=stack.pop(); stack.append(a-b)
    elif op==0x0c: b=stack.pop(); a=stack.pop(); stack.append(a*b)
    elif op==0x0d: b=stack.pop(); a=stack.pop(); stack.append(a/b if b else float('inf'))
    elif op==0x3f: b=stack.pop(); a=stack.pop(); stack.append(a%b)
    elif op==0x50: stack.append(stack.pop()+1)
    elif op==0x51: stack.append(stack.pop()-1)
    elif op==0x4b: stack.append(str(stack.pop()))
    elif op==0x4a: stack.append(float(stack.pop()))
    elif op==0x44: stack.append('object')
    elif op==0x3c: v=stack.pop(); k=stack.pop(); G[k]=v
    elif op==0x41: G[stack.pop()]=UND
    elif op==0x26: stack.pop()
    elif op==0x3e: pass
    elif op==0x00: break
    else:
        # unknown op: best-effort ignore; most leave stack imbalanced only slightly
        pass
def clean(v):
    if v is UND: return None
    if isinstance(v,list): return [clean(x) for x in v]
    if isinstance(v,dict): return {k:clean(x) for k,x in v.items()}
    return v
keys=['APP_NAME','APP_VERSION','NUM_TOURNAMENTS','WINSTRUCT_LEVELS','WINSTRUCT_LISTSIZE','BLINDSTRUCT_LEVELS','BLINDSTRUCT_LISTSIZE','PRIZELIST_LEN','PRIZE_SCROLLSECS','RESULTLIST_LEN','SPONSOR_TEXT','HELPLINK_URL','LOGOLINK_URL','WINSTRUCT_PRESETS','BLINDSTRUCT_PRESETS','THEMES','helpArray']
out={k:clean(G.get(k)) for k in keys}
json.dump(out,open('swf/config.json','w'),indent=1,ensure_ascii=False)
for k in keys[:13]: print(k,'=',out[k])
print('WINSTRUCT_PRESETS:',[ (x['name'], [(pp['maxPlayers'],len(pp['presets'])) for pp in x['presets']]) for x in out['WINSTRUCT_PRESETS']])
print('BLINDSTRUCT_PRESETS:',[ (x['name'], len(x['presets'])) for x in out['BLINDSTRUCT_PRESETS']])
print('THEMES:',out['THEMES'])
