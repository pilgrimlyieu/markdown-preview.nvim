import fs from 'fs'
import Module from 'module'
import path from 'path'
import vm from 'vm'

import modules from './preloadmodules'

interface ModuleWithMutableRequire extends Module {
  require: NodeRequire
}

const nodeModulePaths = (Module as unknown as {
  _nodeModulePaths: (from: string) => string[]
})._nodeModulePaths

export default function load<T = unknown>(scriptPath: string): T {
  const userModule = new Module(scriptPath)
  userModule.filename = scriptPath
  userModule.paths = nodeModulePaths(path.dirname(scriptPath))

  const moduleCode = fs.readFileSync(userModule.filename, 'utf-8')

  const mutableModule = userModule as ModuleWithMutableRequire
  mutableModule.require = Module.createRequire(userModule.filename)

  const sanbox = vm.createContext({
    ...global,
    exports: mutableModule.exports,
    module: mutableModule,
    require: (name: string) => {
      if (modules[name]) {
        return modules[name]
      }
      try {
        return mutableModule.require(name)
      } catch (e) {
        let loadScript = path.join(path.dirname(scriptPath), name)
        if (fs.existsSync(loadScript) && fs.statSync(loadScript).isDirectory()) {
          loadScript = path.join(loadScript, 'index.js')
        } else if (!fs.existsSync(loadScript)) {
          loadScript = `${loadScript}.js`
        }
        return load(loadScript)
      }
    },
    __filename: userModule.filename,
    __dirname: path.dirname(scriptPath),
    process,
  })

  vm.runInContext(moduleCode, sanbox, { filename: userModule.filename })

  return mutableModule.exports as T
}
