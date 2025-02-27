// @name         RPCS3 LLVM Hooker
// @version      
// @author       [DC]
// @description  TODO: linux

const __e = Process.enumerateModules()[0];
const installFunctionPatt1 = '0F86 ???????? 488D?? ?0010000 E8 ???????? 4883C? 68'; // MSVC
let DoJitMatch = Memory.scanSync(__e.base, __e.size, installFunctionPatt1)[0];
if (!DoJitMatch) {
    const installFunctionPatt2 = '660F 1F440000 488D?? ?0010000 E8 ???????? 4883C? 68'; // patched
    DoJitMatch = Memory.scanSync(__e.base, __e.size, installFunctionPatt2)[0];
    if (!DoJitMatch) throw new Error('DoJit not found!');
}

const DoJitPtr = DoJitMatch.address;
const operations = Object.create(null);
const buildRegs = createFunction_buildRegs();

const {_emReg, _jitReg} = (function() {
    let p = Instruction.parse(DoJitPtr); // jbe 0x00 ; long jump
    p = Instruction.parse(p.next);       // lea r?x, ss:[rbp+0x1?0]
    p = Instruction.parse(p.next);       // call 0x00
    p = Instruction.parse(p.next);       // add r?x, 0x68
    const _emReg = p.operands[0].value;
    p = Instruction.parse(DoJitPtr.sub(0x16)); // lea rdx, ds:[rax+rcx*2]
    const _jitReg = p.operands[0].value;

    // nop jbe & je:
    const isPPUDebugIfPtr = DoJitPtr.sub(0x21);
    Memory.protect(isPPUDebugIfPtr, 0x40, 'rwx');
    DoJitPtr.writeByteArray([0x66, 0x0F, 0x1F, 0x44, 0x00, 0x00]); // 6bytes nop
    isPPUDebugIfPtr.writeByteArray([0x66, 0x90]); // 2bytes nop

    return {_emReg, _jitReg};
})();

// https://github.com/RPCS3/rpcs3/blob/ab50e5483ed428d79bccf0a37b58415f9c8456fd/rpcs3/Emu/Cell/PPUThread.cpp#L3405

Interceptor.attach(DoJitPtr.add(6), {
    onEnter: function (args) {
        const em_address = this.context[_emReg].readU32(); // func_addr
        const op = operations[em_address];
        if (op !== undefined) {
            const entrypoint = this.context[_jitReg].readPointer().sub(0x0008000000000000); // ppu_ref
            console.log('Attach:', ptr(em_address), entrypoint);
            Breakpoint.add(entrypoint, function () {
                const thiz = Object.create(null);
                thiz.context = Object.create(null);
                thiz.context.pc = em_address;
                const regs = buildRegs(this.context); // x0 x1 x2 ...

                op.call(thiz, regs);
            });
        }
    }
});

function createFunction_buildRegs() {
    let body = '';

    body += 'const base = context.rbx;'; // 0x0000000300000000
    body += 'const regs = context.rbp.add(0x18);';

    // ppc64: https://www.ibm.com/docs/en/aix/7.1?topic=overview-register-usage-conventions
    // r0: In function prologs.
    // r1: 	Stack pointer.
    // r2: Table of Contents (TOC) pointer.
    // r3: First word of a function's argument list; first word of a scalar function return.
    // r4: Second word of a function's argument list; second word of a scalar function return.
    // ... r12 (glink)
    body += 'const args = [';
    for (let i = 3; i < 13; i++) {
        let offset = i * 8;
        body += '{';
        body += `_vm: regs.add(${offset}).readU64().toNumber(),`
        body += `get value() { return base.add(this._vm); },`; // host address
        body += `set vm(val) { this._vm = val; },`;
        body += `get vm() { return this._vm },`;
        body += `save() {regs.add(${offset}).writeU64(this._vm); return this; }`
        body += '},';
    }
    body += '];'
    body += 'return args;';
    return new Function('context', body);
};

function setHook(object) {
    for (const key in object) {
        if (Object.hasOwnProperty.call(object, key)) {
            const element = object[key];
            operations[key] = element;
        }
    }
}

module.exports = exports = {
    setHook
}