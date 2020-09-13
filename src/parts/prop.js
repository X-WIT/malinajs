
import { assert, detectExpressionType, isSimpleName } from '../utils.js'


export function bindProp(prop, makeEl, node) {
    let name, arg;
    if(prop.name[0] == '@') {
        arg = prop.name.substring(1);
        name = 'on';
    }
    if(!name && prop.name[0] == ':') {
        name = 'bind';
        arg = prop.name.substring(1);
    }
    if(!name && prop.name[0] == '*') {
        let rx = prop.name.match(/^\*\{.*\}$/);
        if(rx) {
            assert(prop.value == null, 'wrong binding: ' + prop.content);
            name = 'use';
            prop.value = prop.name.substring(1);
        } else {
            name = 'use';
            arg = prop.name.substring(1);
        }
    }
    if(!name && prop.value == null) {
        let rx = prop.name.match(/^\{(.*)\}$/);
        if(rx) {
            name = rx[1];
            if(name.startsWith('...')) {
                // spread operator
                name = name.substring(3);
                assert(detectExpressionType(name) == 'identifier');
                return {bind: `
                    ${node.spreadObject}.spread(() => ${name});
                `};
            } else {
                prop.value = prop.name;
            }
        }
    }
    if(!name) {
        let r = prop.name.match(/^(\w+)\:(.*)$/)
        if(r) {
            name = r[1];
            arg = r[2];
        } else name = prop.name;
    }

    function getExpression() {
        let exp = prop.value.match(/^\{(.*)\}$/)[1];
        assert(exp, prop.content);
        return exp;
    }

    if(name[0] == '#') {
        let target = name.substring(1);
        assert(isSimpleName(target), target);
        this.checkRootName(target);
        return {bind: `${target}=${makeEl()};`};
    } else if(name == 'on') {
        if(arg == '@') {
            assert(!prop.value);
            return {bind: `
                {
                    for(let event in $option.events) {
                        $runtime.addEvent($cd, ${makeEl()}, event, $option.events[event]);
                    }
                }
            `};
        }
        let mod = '', opts = arg.split(/[\|:]/);
        let event = opts.shift();
        let exp, handler, funcName;
        if(prop.value) {
            exp = getExpression();
        } else {
            if(!opts.length) {
                // forwarding
                return {bind: `
                    $runtime.addEvent($cd, ${makeEl()}, "${event}", ($event) => {
                        const fn = $option.events.${event};
                        if(fn) fn($event);
                    });\n`
                };
            }
            handler = opts.pop();
        };
        assert(event, prop.content);
        assert(!handler ^ !exp, prop.content);

        let needPrevent, preventInserted;
        opts.forEach(opt => {
            if(opt == 'preventDefault') {
                if(preventInserted) return;
                mod += '$event.preventDefault();';
                preventInserted = true;
            } else if(opt == 'stopPropagation') {
                mod += '$event.stopPropagation();';
            } else if(opt == 'enter') {
                mod += 'if($event.keyCode != 13) return;';
                needPrevent = true;
            } else if(opt == 'escape') {
                mod += 'if($event.keyCode != 27) return;';
                needPrevent = true;
            } else throw 'Wrong modificator: ' + opt;
        });
        if(needPrevent && !preventInserted) mod += '$event.preventDefault();';

        if(exp) {
            let type = detectExpressionType(exp);
            if(type == 'identifier') {
                handler = exp;
                exp = null;
            } else if(type == 'function') {
                funcName = 'fn' + (this.uniqIndex++);
            };
        }

        if(funcName) {
            return {bind: `
                {
                    let $element=${makeEl()};
                    const ${funcName} = ${exp};
                    $runtime.addEvent($cd, $element, "${event}", ($event) => { ${mod} ${funcName}($event); $$apply();});
                }`
            };
        } else if(handler) {
            this.checkRootName(handler);
            return {bind: `
                {
                    let $element=${makeEl()};
                    $runtime.addEvent($cd, $element, "${event}", ($event) => { ${mod} ${handler}($event); $$apply();});
                }`
            };
        } else {
            return {bind: `
                {
                    let $element=${makeEl()};
                    $runtime.addEvent($cd, $element, "${event}", ($event) => { ${mod} ${this.Q(exp)}; $$apply(); });
                }`
            };
        }
    } else if(name == 'bind') {
        let exp;
        arg = arg.split(/[\:\|]/);
        let attr = arg.shift();
        assert(attr, prop.content);

        if(prop.value) exp = getExpression();
        else {
            if(arg.length) exp = arg.pop();
            else exp = attr;
        }
        assert(['value', 'checked', 'valueAsNumber', 'valueAsDate', 'selectedIndex'].includes(attr), 'Not supported: ' + prop.content);
        assert(arg.length == 0);
        assert(detectExpressionType(exp) == 'identifier', 'Wrong bind name: ' + prop.content);
        let watchExp = attr == 'checked' ? '!!' + exp : exp;

        let spreading = '';
        if(node.spreadObject) spreading = `${node.spreadObject}.except(['${attr}']);`;

        return {bind: `{
            ${spreading}
            let $element=${makeEl()};
            $runtime.addEvent($cd, $element, 'input', () => { ${exp}=$element.${attr}; $$apply(); });
            $watchReadOnly($cd, () => (${watchExp}), (value) => { if(value != $element.${attr}) $element.${attr} = value; });
        }`};
    } else if(name == 'class' && arg) {
        let className = arg;
        let exp = prop.value ? getExpression() : className;

        let bind = [];
        let returnProp;

        let classObject = this.css && this.css.simpleClasses[className];
        if(!classObject) {
            bind.push(`$runtime.bindClass($cd, ${makeEl()}, () => !!(${exp}), '${className}');`);
        } else {
            let localHash = null;
            if(classObject.notBound) localHash = classObject.useAsLocal();
            else if(node.injectCssHash) localHash = this.css.id;
            node.injectCssHash = false;
            
            if(classObject.bound) {
                let defaultHash = classObject.useAsBound();
                bind.push(`$runtime.bindBoundClass($cd, ${makeEl()}, () => !!(${exp}), '${className}', '${defaultHash}', $option);`);
            } else {
                bind.push(`$runtime.bindClass($cd, ${makeEl()}, () => !!(${exp}), '${className}');`);
            }
            if(localHash) returnProp = `class="${localHash}"`;
        }
        return {bind: bind.join('\n'), prop: returnProp};
    } else if(name == 'style' && arg) {
        let styleName = arg;
        let exp = prop.value ? getExpression() : styleName;
        return {bind: `{
                let $element = ${makeEl()};
                $watchReadOnly($cd, () => (${exp}), (value) => { $element.style.${styleName} = value; });
            }`};
    } else if(name == 'use') {
        if(arg) {
            assert(isSimpleName(arg), 'Wrong name: ' + arg);
            this.checkRootName(arg);
            let args = prop.value ? getExpression() : '';
            let code = `$tick(() => {
                let useObject = ${arg}(${makeEl()}${args ? ', ' + args : ''});\n if(useObject) {`;
            if(args) code += `
                if(useObject.update) {
                    let w = $watch($cd, () => [${args}], (args) => {useObject.update.apply(useObject, args);}, {cmp: $runtime.$$compareArray});
                    w.value = w.fn();
                }`;
            code += `if(useObject.destroy) $runtime.cd_onDestroy($cd, useObject.destroy);}});`;
            return {bind: code};
        }
        let exp = getExpression();
        return {bind: `{
            let $element=${makeEl()};
            $tick(() => { ${exp}; $$apply(); });}`};
    } else {
        if(prop.value && prop.value.indexOf('{') >= 0) {
            let exp = this.parseText(prop.value);

            if(node.spreadObject) {
                return {bind: `
                    ${node.spreadObject}.prop('${name}', () => ${exp});
                `};
            }
            const propList = {
                hidden: true,
                checked: true,
                value: true,
                disabled: true,
                selected: true,
                innerHTML: true,
                innerText: true,
                placeholder: true,
                src: true
            }
            if(propList[name]) {
                return {bind: `{
                    let $element=${makeEl()};
                    $watchReadOnly($cd, () => (${exp}), (value) => {$element.${name} = value;});
                }`};
            } else {
                let suffix = '', scopedClass = name == 'class' && this.css;  // scope any dynamic class
                if(scopedClass) {
                    let passed = prop.value.match(/^\{\s*\$class\s*\}$/) || prop.value.match(/^\{\s*\$class\.\w+\s*\}$/)
                    if(!passed) suffix = `+' ${this.css.id}'`;
                }
                return {
                    bind: `{
                        let $element=${makeEl()};
                        $watchReadOnly($cd, () => (${exp})${suffix}, (value) => {
                            if(value != null) $element.setAttribute('${name}', value);
                            else $element.removeAttribute('${name}');
                        });
                    }`,
                    scopedClass: scopedClass
                };
            }
        }

        if(node.spreadObject) {
            return {bind: `
                ${node.spreadObject}.attr('${name}', '${prop.value}');
            `};
        }

        if(name == 'class' && this.css) {
            let classList = prop.value.trim();
            if(!classList) return {};

            let result = {};
            let bind = [];
            if(node.injectCssHash) result[this.css.id] = true;
            node.injectCssHash = false;
            classList.split(/\s+/).forEach(name => {
                let c = this.css.simpleClasses[name];
                if(c) {
                    if(c.bound) {
                        let hash = c.useAsBound();
                        bind.push(`$runtime.bindParentClass($cd, ${makeEl()}, '${name}', '${hash}', $option)`);
                    }
                    if(c.notBound) {
                        result[name] = true;
                        result[c.useAsLocal()] = true;
                    }
                } else {
                    result[name] = true;
                }
            });
            classList = Object.keys(result).join(' ');

            return {
                prop: `class="${classList}"`,
                bind: bind.join('\n')
            }
        }
        return {
            prop: prop.content
        }
    }
};
