import { TypedUseSelectorHook, useDispatch, useSelector, useStore } from 'react-redux'
import type { RootState, AppDispatch, AppStore } from './store'

export const useAppDispatch = () => useDispatch<AppDispatch>()
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector
// withTypes preserves the thunk-aware AppDispatch on store.dispatch (a bare
// useStore<RootState>() erases it to Dispatch<UnknownAction>).
export const useAppStore = useStore.withTypes<AppStore>()
