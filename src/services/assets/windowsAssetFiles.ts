import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export const ASSET_MAX_BYTES = 2 * 1024 * 1024;
export type AssetFileReason = "unsupported_platform" | "native_backend_unavailable" |
  "asset_path_invalid" | "asset_parent_unsupported" | "asset_parent_unavailable" |
  "asset_binding_conflict" | "asset_exists" | "asset_absent" | "asset_invalid_file" |
  "asset_io_failed" | "asset_read_limit" | "asset_effect_unverified";
export class AssetFileError extends Error {
  constructor(readonly reason: AssetFileReason) { super(reason); this.name = "AssetFileError"; }
}
function fail(reason: AssetFileReason): never { throw new AssetFileError(reason); }
export const assetHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function assetSegment(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 160 ||
      value.normalize("NFC") !== value || Buffer.from(value,"utf8").toString("utf8") !== value || /[\x00-\x1f\x7f<>:"/\\|?*\[\]#^]/u.test(value) ||
      /^\./u.test(value) || /[. ]$/u.test(value) ||
      /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(?:\.|$)/iu.test(value)) fail("asset_path_invalid");
  return value;
}
export function assetFilename(value: string): string {
  assetSegment(value);
  if (!/\.(?:webp|png|jpg|jpeg|gif|svg|avif)$/u.test(value)) fail("asset_path_invalid");
  return value;
}

type Handle = bigint | null;
type NativeInfo = { attributes: number; volume: number; indexHigh: number; indexLow: number;
  sizeHigh: number; sizeLow: number; links: number; [key: string]: number };
type NativeApi = { koffi: any; open: (...args: any[]) => number; info: (...args: any[]) => number;
  close: (handle: Handle) => number; write: (...args: any[]) => number; read: (...args: any[]) => number;
  seek: (...args: any[]) => number; flush: (handle: Handle) => number;
  drive: (root: string) => number; queryVolume: (...args:any[]) => number; volume: (...args: any[]) => number; attributesSize: number };
let nativeApi: NativeApi | undefined;
function native(): NativeApi {
  if (process.platform !== "win32" || process.arch !== "x64") fail("unsupported_platform");
  if (nativeApi) return nativeApi;
  try {
    // Optional native dependency; absence never falls back to path-based writing.
    const koffi = createRequire(import.meta.url)("koffi");
    const nt = koffi.load("ntdll.dll"), kernel = koffi.load("kernel32.dll");
    koffi.struct("OptimikeAssetUnicode", { length:"uint16_t", maximumLength:"uint16_t", buffer:"void *" });
    const attributes = koffi.struct("OptimikeAssetAttributes", { length:"uint32_t", root:"void *",
      name:"OptimikeAssetUnicode *", attributes:"uint32_t", security:"void *", qos:"void *" });
    koffi.struct("OptimikeAssetIoStatus", { status:"uintptr_t", information:"uintptr_t" });
    koffi.struct("OptimikeAssetFileInfo", { attributes:"uint32_t", creationLow:"uint32_t", creationHigh:"uint32_t",
      accessLow:"uint32_t", accessHigh:"uint32_t", writeLow:"uint32_t", writeHigh:"uint32_t",
      volume:"uint32_t", sizeHigh:"uint32_t", sizeLow:"uint32_t", links:"uint32_t", indexHigh:"uint32_t", indexLow:"uint32_t" });
    nativeApi = { koffi, attributesSize:koffi.sizeof(attributes),
      open:nt.func("int32_t __stdcall NtCreateFile(_Out_ void **handle, uint32_t access, const OptimikeAssetAttributes *attributes, _Out_ OptimikeAssetIoStatus *status, void *allocation, uint32_t fileAttributes, uint32_t share, uint32_t disposition, uint32_t options, void *ea, uint32_t eaLength)"),
      info:kernel.func("int __stdcall GetFileInformationByHandle(void *file, _Out_ OptimikeAssetFileInfo *information)"),
      close:kernel.func("int __stdcall CloseHandle(void *file)"),
      write:kernel.func("int __stdcall WriteFile(void *file, const void *data, uint32_t length, _Out_ uint32_t *written, void *overlapped)"),
      read:kernel.func("int __stdcall ReadFile(void *file, _Out_ void *data, uint32_t length, _Out_ uint32_t *read, void *overlapped)"),
      seek:kernel.func("int __stdcall SetFilePointerEx(void *file, int64_t offset, void *position, uint32_t method)"),
      flush:kernel.func("int __stdcall FlushFileBuffers(void *file)"),
      queryVolume:nt.func("int32_t __stdcall NtQueryVolumeInformationFile(void *file, _Out_ OptimikeAssetIoStatus *status, _Out_ void *information, uint32_t length, uint32_t informationClass)"),
      drive:kernel.func("uint32_t __stdcall GetDriveTypeW(const char16_t *root)"),
      volume:kernel.func("int __stdcall GetVolumeInformationByHandleW(void *file, void *name, uint32_t nameLength, void *serial, void *maximumComponent, void *flags, _Out_ void *filesystem, uint32_t filesystemLength)"),
    };
    return nativeApi;
  } catch { fail("native_backend_unavailable"); }
}
function info(api: NativeApi, handle: Handle): NativeInfo {
  const value = {} as NativeInfo;
  if (!api.info(handle, value)) fail("asset_io_failed");
  return value;
}
const identity = (value: NativeInfo) => [value.volume, value.indexHigh, value.indexLow].join(":");
function open(api: NativeApi, name: string, root: Handle, directory: boolean, create = false): Handle {
  const bytes = Buffer.from(name,"utf16le"), handle: Handle[] = [null], status = {};
  if (bytes.length > 65532) fail("asset_path_invalid");
  const attrs = { length:api.attributesSize, root,
    name:{ length:bytes.length, maximumLength:bytes.length, buffer:bytes }, attributes:0x40, security:null, qos:null };
  // Each ordinary parent is opened relative to the previously held directory.
  // No FILE_SHARE_DELETE on parents; no WRITE/DELETE sharing on the leaf.
  const result = api.open(handle, directory ? 0x1000a0 : create ? 0x100183 : 0x100081,
    attrs, status, null, 0x80, directory ? 3 : 1, create ? 2 : 1,
    0x200000 | 0x20 | (directory ? 1 : 0x40), null, 0);
  if (result !== 0) {
    if (handle[0]) api.close(handle[0]);
    if (!directory && (result >>> 0) === 0xc0000035) fail("asset_exists");
    if (!directory && (result >>> 0) === 0xc0000034) fail("asset_absent");
    fail(directory ? "asset_parent_unavailable" : "asset_io_failed");
  }
  if (!handle[0]) fail("asset_io_failed");
  return handle[0];
}

/** Fixed local NTFS only. No POSIX/UNC/cloud/junction fallback and no parent creation. */
export class WindowsAssetFiles {
  private readonly driveRoot: string;
  private readonly parents: string[];
  constructor(vaultRoot: string, assetFolder: string) {
    if (typeof vaultRoot !== "string" || !/^[A-Za-z]:\\/u.test(vaultRoot) ||
        vaultRoot !== path.win32.normalize(vaultRoot) || vaultRoot.endsWith("\\") ||
        typeof assetFolder !== "string" || !assetFolder || assetFolder.includes("\\")) fail("asset_path_invalid");
    this.driveRoot = path.win32.parse(vaultRoot).root;
    this.parents = [...vaultRoot.slice(this.driveRoot.length).split("\\"), ...assetFolder.split("/")].map(assetSegment);
  }
  private withParent<T>(action:(api:NativeApi, parent:Handle, binding:string)=>T):T {
    const api=native();
    if(api.drive(this.driveRoot)!==3) fail("asset_parent_unsupported");
    const held:Handle[]=[], identities:string[]=[];
    try {
      let parent=open(api,"\\??\\"+this.driveRoot,null,true); held.push(parent);
      const device=Buffer.alloc(8), deviceStatus:{information?:number|bigint}={};
      const result=api.queryVolume(parent,deviceStatus,device,device.length,4);
      // FileFsDeviceInformation is queried on the opened handle. A drive-letter
      // check before open cannot establish locality against namespace replacement.
      assertLocalAssetDevice(result,deviceStatus.information,device);
      const fsname=Buffer.alloc(128);
      if(!api.volume(parent,null,0,null,null,null,fsname,64) || fsname.toString("utf16le").replace(/\0.*$/su,"")!=="NTFS")
        fail("asset_parent_unsupported");
      for(const component of this.parents) {
        parent=open(api,component,parent,true); held.push(parent);
        const data=info(api,parent);
        if((data.attributes&0x400)!==0 || (data.attributes&0x10)===0) fail("asset_parent_unsupported");
        identities.push(identity(data));
      }
      const binding=assetHash(Buffer.from(JSON.stringify(identities)));
      return action(api,parent,binding);
    } finally { for(const handle of held.reverse()) api.close(handle); }
  }
  private readHandle(api:NativeApi, handle:Handle):{ bytes:Buffer; identity:string } {
    const before=info(api,handle), size=before.sizeHigh*4294967296+before.sizeLow;
    if((before.attributes&0x410)!==0 || before.links!==1) fail("asset_invalid_file");
    if(size>ASSET_MAX_BYTES) fail("asset_read_limit");
    if(!api.seek(handle,0,null,0)) fail("asset_io_failed");
    const bytes=Buffer.alloc(size+1), count=[0];
    if(!api.read(handle,bytes,bytes.length,count,null) || count[0]!==size) fail("asset_io_failed");
    const after=info(api,handle);
    if(identity(before)!==identity(after)||after.links!==1||before.sizeHigh!==after.sizeHigh||before.sizeLow!==after.sizeLow||
       before.writeHigh!==after.writeHigh||before.writeLow!==after.writeLow) fail("asset_effect_unverified");
    return {bytes:bytes.subarray(0,size),identity:identity(after)};
  }
  inspect(filename:string, expectedBinding?:string): {binding:string;exists:false}|{binding:string;exists:true;sha256:string;size:number;fileIdentity:string} {
    assetFilename(filename);
    return this.withParent((api,parent,binding)=>{
      if(expectedBinding && expectedBinding!==binding) fail("asset_binding_conflict");
      let handle:Handle;
      try {handle=open(api,filename,parent,false);} catch(error) {
        if(error instanceof AssetFileError && error.reason==="asset_absent")return {binding,exists:false};
        throw error;
      }
      try {const value=this.readHandle(api,handle);return {binding,exists:true,sha256:assetHash(value.bytes),size:value.bytes.length,fileIdentity:value.identity};}
      finally {api.close(handle);}
    });
  }
  create(filename:string, bytes:Buffer, expectedBinding:string, afterParentsLocked?:()=>void): {sha256:string;size:number;fileIdentity:string} {
    assetFilename(filename);
    if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>ASSET_MAX_BYTES) fail("asset_read_limit");
    if(!/^[a-f0-9]{64}$/u.test(expectedBinding)) fail("asset_binding_conflict");
    return this.withParent((api,parent,binding)=>{
      if(binding!==expectedBinding)fail("asset_binding_conflict");
      // Internal fault-injection hook; never an MCP argument or runtime option.
      afterParentsLocked?.();
      const handle=open(api,filename,parent,false,true);
      try {
        const written=[0];
        if(!api.write(handle,bytes,bytes.length,written,null)||written[0]!==bytes.length||!api.flush(handle)) fail("asset_effect_unverified");
        const actual=this.readHandle(api,handle);
        if(!bytes.equals(actual.bytes))fail("asset_effect_unverified");
        return {sha256:assetHash(actual.bytes),size:actual.bytes.length,fileIdentity:actual.identity};
      } finally {api.close(handle);}
    });
  }
}


/** FILE_DEVICE_DISK; refuse REMOTE_DEVICE and REMOVABLE_MEDIA. */
export function assertLocalAssetDevice(status:number, length:number|bigint|undefined, bytes:Buffer):void {
  if(status!==0 || Number(length)!==8 || bytes.length!==8 || bytes.readUInt32LE(0)!==7 ||
     (bytes.readUInt32LE(4)&0x11)!==0) fail("asset_parent_unsupported");
}
