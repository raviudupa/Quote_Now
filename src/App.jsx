import React from 'react'
import { ThemeProvider, createTheme, alpha } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import ChatBot from './components/ChatBot'

const theme = createTheme({
  palette: {
    primary: { main: '#2E7D32', light: '#57A65C', dark: '#1B5E20' },
    secondary: { main: '#FF9800', light: '#FFB74D', dark: '#F57C00' },
    background: { default: '#F4F6F8', paper: '#FFFFFF' },
    success: { main: '#2e7d32' },
    info: { main: '#1976d2' }
  },
  typography: {
    fontFamily: 'Inter, Roboto, Helvetica, Arial, sans-serif',
    h4: { fontWeight: 700, letterSpacing: 0.2 },
    h5: { fontWeight: 700, letterSpacing: 0.2 },
    h6: { fontWeight: 700, letterSpacing: 0.1 },
    button: { textTransform: 'none', fontWeight: 600 }
  },
  shape: { borderRadius: 12 },
  shadows: [
    'none',
    '0 3px 10px rgba(0,0,0,0.06)',
    '0 6px 16px rgba(0,0,0,0.08)',
    '0 10px 24px rgba(0,0,0,0.10)',
    ...Array(21).fill('0 10px 24px rgba(0,0,0,0.10)')
  ],
  components: {
    MuiCssBaseline: {
      styleOverrides: (themeArg) => ({
        body: {
          backgroundImage: `radial-gradient(${alpha('#2E7D32', 0.05)} 1px, transparent 1px)`,
          backgroundSize: '16px 16px'
        }
      })
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: 10 },
        containedPrimary: { boxShadow: '0 6px 18px rgba(46,125,50,0.25)' }
      }
    },
    MuiChip: {
      styleOverrides: {
        root: { borderRadius: 16 },
        outlined: { borderColor: alpha('#000', 0.12) }
      }
    },
    MuiPaper: {
      styleOverrides: {
        root: { borderRadius: 12 }
      }
    },
    MuiDialog: {
      styleOverrides: {
        paper: { borderRadius: 16, boxShadow: '0 20px 40px rgba(0,0,0,0.15)' }
      }
    },
    MuiCard: {
      styleOverrides: { root: { borderRadius: 14, boxShadow: '0 8px 24px rgba(0,0,0,0.08)' } }
    },
    MuiAvatar: {
      styleOverrides: { root: { boxShadow: '0 2px 6px rgba(0,0,0,0.15)' } }
    },
    MuiTooltip: {
      styleOverrides: { tooltip: { borderRadius: 8 } }
    },
    MuiDivider: {
      styleOverrides: { root: { opacity: 0.8 } }
    }
  }
})

function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ChatBot />
    </ThemeProvider>
  )
}

export default App
