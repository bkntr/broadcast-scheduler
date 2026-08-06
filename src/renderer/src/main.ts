import './app.css'
import App from './App.svelte'
import { mount } from 'svelte'
import { installWebApi } from '../../web/api'

installWebApi()
mount(App, { target: document.getElementById('app')! })
