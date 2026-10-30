import struct, sys
data=open(sys.argv[1],'rb').read()
# split DoAction tags again from the uncompressed swf
def tags(d):
    p=8; nbits=d[p]>>3; p+=(5+4*nbits+7)//8; p+=4
    while p<len(d):
        h=struct.unpack('<H',d[p:p+2])[0]; code=h>>6; ln=h&0x3f; p+=2
        if ln==0x3f: ln=struct.unpack('<I',d[p:p+4])[0]; p+=4
        yield code, d[p:p+ln]; p+=ln
        if code==0: break
NAMES={0x04:'NextFrame',0x05:'PrevFrame',0x06:'Play',0x07:'Stop',0x0a:'Add',0x0b:'Subtract',0x0c:'Multiply',0x0d:'Divide',0x0e:'Equals',0x0f:'Less',0x10:'And',0x11:'Or',0x12:'Not',0x13:'StringEquals',0x14:'StringLength',0x15:'StringExtract',0x17:'Pop',0x18:'ToInteger',0x1c:'GetVariable',0x1d:'SetVariable',0x20:'SetTarget2',0x21:'StringAdd',0x22:'GetProperty',0x23:'SetProperty',0x24:'CloneSprite',0x25:'RemoveSprite',0x26:'Trace',0x27:'StartDrag',0x28:'EndDrag',0x29:'StringLess',0x2a:'Throw',0x2b:'CastOp',0x2c:'ImplementsOp',0x30:'RandomNumber',0x31:'MBStringLength',0x32:'CharToAscii',0x33:'AsciiToChar',0x34:'GetTime',0x35:'MBStringExtract',0x36:'MBCharToAscii',0x37:'MBAsciiToChar',0x3a:'Delete',0x3b:'Delete2',0x3c:'DefineLocal',0x3d:'CallFunction',0x3e:'Return',0x3f:'Modulo',0x40:'NewObject',0x41:'DefineLocal2',0x42:'InitArray',0x43:'InitObject',0x44:'TypeOf',0x45:'TargetPath',0x46:'Enumerate',0x47:'Add2',0x48:'Less2',0x49:'Equals2',0x4a:'ToNumber',0x4b:'ToString',0x4c:'PushDuplicate',0x4d:'StackSwap',0x4e:'GetMember',0x4f:'SetMember',0x50:'Increment',0x51:'Decrement',0x52:'CallMethod',0x53:'NewMethod',0x54:'InstanceOf',0x55:'Enumerate2',0x60:'BitAnd',0x61:'BitOr',0x62:'BitXor',0x63:'BitLShift',0x64:'BitRShift',0x65:'BitURShift',0x66:'StrictEquals',0x67:'Greater',0x68:'StringGreater',0x69:'Extends',0x81:'GotoFrame',0x83:'GetURL',0x87:'StoreRegister',0x88:'ConstantPool',0x8a:'WaitForFrame',0x8b:'SetTarget',0x8c:'GotoLabel',0x8d:'WaitForFrame2',0x8e:'DefineFunction2',0x8f:'Try',0x94:'With',0x96:'Push',0x99:'Jump',0x9a:'GetURL2',0x9b:'DefineFunction',0x9d:'If',0x9e:'Call',0x9f:'GotoFrame2'}
out=[]
def dis(code, base=0, indent=0):
    pool=[]
    p=0
    while p<len(code):
        op=code[p]; p+=1
        if op>=0x80:
            ln=struct.unpack('<H',code[p:p+2])[0]; p+=2
            body=code[p:p+ln]; p+=ln
        else: body=b''
        pre='  '*indent + f'{base+p:06x} '
        n=NAMES.get(op,f'op{op:02x}')
        if op==0x88:
            cnt=struct.unpack('<H',body[:2])[0]; pool=body[2:].split(b'\0')[:cnt]
            pool=[s.decode('utf8','replace') for s in pool]
            out.append(pre+f'ConstantPool({cnt})')
        elif op==0x96:
            q=0; vals=[]
            while q<len(body):
                t=body[q]; q+=1
                if t==0: e=body.index(b'\0',q); vals.append(repr(body[q:e].decode('utf8','replace'))); q=e+1
                elif t==1: vals.append(str(struct.unpack('<f',body[q:q+4])[0])); q+=4
                elif t==2: vals.append('null')
                elif t==3: vals.append('undefined')
                elif t==4: vals.append(f'r{body[q]}'); q+=1
                elif t==5: vals.append(str(bool(body[q]))); q+=1
                elif t==6: vals.append(str(struct.unpack('<d',body[q+4:q+8]+body[q:q+4])[0])); q+=8
                elif t==7: vals.append(str(struct.unpack('<i',body[q:q+4])[0])); q+=4
                elif t==8: vals.append(repr(pool[body[q]]) if body[q]<len(pool) else f'c{body[q]}'); q+=1
                elif t==9: i=struct.unpack('<H',body[q:q+2])[0]; vals.append(repr(pool[i]) if i<len(pool) else f'c{i}'); q+=2
            out.append(pre+'Push '+', '.join(vals))
        elif op in (0x9b,0x8e):
            q=0; e=body.index(b'\0'); name=body[:e].decode(); q=e+1
            nparams=struct.unpack('<H',body[q:q+2])[0]; q+=2
            params=[]
            if op==0x8e:
                regs=body[q]; q+=1; flags=struct.unpack('<H',body[q:q+2])[0]; q+=2
                for _ in range(nparams):
                    r=body[q]; q+=1; e=body.index(b'\0',q); params.append(f'r{r}:'+body[q:e].decode()); q=e+1
            else:
                for _ in range(nparams):
                    e=body.index(b'\0',q); params.append(body[q:e].decode()); q=e+1
            clen=struct.unpack('<H',body[q:q+2])[0]; q+=2
            out.append(pre+f'function {name}({", ".join(params)}) {{')
            fcode=code[p:p+clen]
            # nested funcs inherit pool
            sub_pool=pool
            savepool=pool
            dis_with_pool(fcode, base+p, indent+1, pool)
            p+=clen
            out.append('  '*indent+'}')
        elif op in (0x99,0x9d):
            off=struct.unpack('<h',body)[0]; out.append(pre+f'{n} -> {base+p+off:06x}')
        elif op==0x87: out.append(pre+f'StoreRegister r{body[0]}')
        elif op==0x83: out.append(pre+f'GetURL {body!r}')
        elif op==0x8b: out.append(pre+f'SetTarget {body!r}')
        elif op==0x81: out.append(pre+f'GotoFrame {struct.unpack("<H",body)[0]}')
        elif op==0x8c: out.append(pre+f'GotoLabel {body!r}')
        elif body: out.append(pre+f'{n} {body.hex()}')
        else: out.append(pre+n)
def dis_with_pool(code, base, indent, pool):
    # hack: temporarily run dis with pre-set pool by prepending nothing; we re-implement by closure
    global _pool_override
    _pool_override=pool
    dis2(code, base, indent, pool)
def dis2(code, base, indent, pool):
    # same as dis but seeded pool
    src=dis.__code__
    # simplest: copy of dis body with pool seeded
    p=0
    while p<len(code):
        op=code[p]; p+=1
        if op>=0x80:
            ln=struct.unpack('<H',code[p:p+2])[0]; p+=2
            body=code[p:p+ln]; p+=ln
        else: body=b''
        pre='  '*indent + f'{base+p:06x} '
        n=NAMES.get(op,f'op{op:02x}')
        if op==0x88:
            cnt=struct.unpack('<H',body[:2])[0]; pool[:]=[s.decode('utf8','replace') for s in body[2:].split(b'\0')[:cnt]]
            out.append(pre+f'ConstantPool({cnt})')
        elif op==0x96:
            q=0; vals=[]
            while q<len(body):
                t=body[q]; q+=1
                if t==0: e=body.index(b'\0',q); vals.append(repr(body[q:e].decode('utf8','replace'))); q=e+1
                elif t==1: vals.append(str(struct.unpack('<f',body[q:q+4])[0])); q+=4
                elif t==2: vals.append('null')
                elif t==3: vals.append('undefined')
                elif t==4: vals.append(f'r{body[q]}'); q+=1
                elif t==5: vals.append(str(bool(body[q]))); q+=1
                elif t==6: vals.append(str(struct.unpack('<d',body[q+4:q+8]+body[q:q+4])[0])); q+=8
                elif t==7: vals.append(str(struct.unpack('<i',body[q:q+4])[0])); q+=4
                elif t==8: vals.append(repr(pool[body[q]]) if body[q]<len(pool) else f'c{body[q]}'); q+=1
                elif t==9: i=struct.unpack('<H',body[q:q+2])[0]; vals.append(repr(pool[i]) if i<len(pool) else f'c{i}'); q+=2
            out.append(pre+'Push '+', '.join(vals))
        elif op in (0x9b,0x8e):
            q=0; e=body.index(b'\0'); name=body[:e].decode(); q=e+1
            nparams=struct.unpack('<H',body[q:q+2])[0]; q+=2
            params=[]
            if op==0x8e:
                regs=body[q]; q+=1; flags=struct.unpack('<H',body[q:q+2])[0]; q+=2
                for _ in range(nparams):
                    r=body[q]; q+=1; e=body.index(b'\0',q); params.append(f'r{r}:'+body[q:e].decode()); q=e+1
            else:
                for _ in range(nparams):
                    e=body.index(b'\0',q); params.append(body[q:e].decode()); q=e+1
            clen=struct.unpack('<H',body[q:q+2])[0]; q+=2
            out.append(pre+f'function {name}({", ".join(params)}) {{')
            dis2(code[p:p+clen], base+p, indent+1, pool)
            p+=clen
            out.append('  '*indent+'}')
        elif op in (0x99,0x9d):
            off=struct.unpack('<h',body)[0]; out.append(pre+f'{n} -> {base+p+off:06x}')
        elif op==0x87: out.append(pre+f'StoreRegister r{body[0]}')
        elif op==0x83: out.append(pre+f'GetURL {body!r}')
        elif op==0x8b: out.append(pre+f'SetTarget {body!r}')
        elif op==0x81: out.append(pre+f'GotoFrame {struct.unpack("<H",body)[0]}')
        elif op==0x8c: out.append(pre+f'GotoLabel {body!r}')
        elif body: out.append(pre+f'{n} {body.hex()}')
        else: out.append(pre+n)
i=0
for code,body in tags(data):
    if code in (12,59):
        out.append(f'===== DoAction #{i} ({len(body)} bytes) =====')
        dis2(body,0,0,[]); i+=1
open(sys.argv[2],'w').write('\n'.join(out))
print(len(out),'lines')
