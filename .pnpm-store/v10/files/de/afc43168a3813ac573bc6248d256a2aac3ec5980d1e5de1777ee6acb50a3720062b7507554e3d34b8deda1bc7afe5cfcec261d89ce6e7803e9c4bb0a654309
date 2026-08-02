import parseArgs from '../util/parse-args.js';
export const argsFrom = (args, from) => args.slice(args.indexOf(from));
export const argsAfter = (args, token) => {
    const index = args.indexOf(token);
    return index === -1 ? [] : args.slice(index + 1).filter(arg => arg !== '--');
};
export const expandScript = (name, forwardedArgs, scripts, options, opts = {}) => {
    const source = scripts?.[name];
    if (!source || forwardedArgs.length === 0)
        return;
    const expandedScripts = options.expandedScripts ?? new Set();
    if (expandedScripts.has(name))
        return;
    expandedScripts.add(name);
    return options.fromArgs([source, ...forwardedArgs], { ...opts, expandedScripts });
};
export const parseNodeArgs = (args) => parseArgs(args, {
    string: ['r'],
    alias: { require: ['r', 'loader', 'experimental-loader', 'test-reporter', 'watch', 'import'] },
});
