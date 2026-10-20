import React, { useState, useEffect, useMemo, useRef } from 'react';
import { apiCall } from './api.js';

export default function FilterPanel({ 
  filters = [], 
  onSearch, 
  loading = false, 
  user, 
  defaultFilters = {},
  pageGroupId
}) {
  const [dynamicLookups, setDynamicLookups] = useState(null);

  useEffect(() => {
    if (pageGroupId) {
      apiCall('GetQueryMaster', {}, {}, 'plus').then(d => {
        if (d.State === 0) {
          const queries = d.List0 || [];
          const lookups = queries.filter(q => q.PageGroupID === pageGroupId && q.QueryType === 'Lookup').map(q => q.Operation);
          setDynamicLookups(lookups);
        }
      });
    }
  }, [pageGroupId]);

  const hasAccount = pageGroupId && dynamicLookups ? dynamicLookups.includes('Accounts Master All') : filters.includes('account');
  const hasDate = filters.includes('date');
  const hasCurrency = filters.includes('currency');
  const hasCustomer = pageGroupId && dynamicLookups ? dynamicLookups.includes('Customer Master All') : filters.includes('customer');
  const hasVendor = pageGroupId && dynamicLookups ? dynamicLookups.includes('Vendor Master All') : filters.includes('vendor');
  const hasBank = pageGroupId && dynamicLookups ? dynamicLookups.includes('Bank Accounts Master') : filters.includes('bank');
  const hasAsset = pageGroupId && dynamicLookups ? dynamicLookups.includes('Asset Master All') : filters.includes('asset');
  const hasEmployee = pageGroupId && dynamicLookups ? dynamicLookups.includes('Employee Master All') : filters.includes('employee');
  const hasExpense = pageGroupId && dynamicLookups ? dynamicLookups.includes('Expense Master All') : filters.includes('expense');
  const hasDebtor = pageGroupId && dynamicLookups ? dynamicLookups.includes('DebtorCreditor Master All') : filters.includes('debtor');
  const hasItem = pageGroupId && dynamicLookups ? dynamicLookups.includes('Item Master All') : filters.includes('item');

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isDateCollapsed, setIsDateCollapsed] = useState(false);
  const [isCurrencyCollapsed, setIsCurrencyCollapsed] = useState(false);
  const [isCustomerCollapsed, setIsCustomerCollapsed] = useState(false);
  const [isVendorCollapsed, setIsVendorCollapsed] = useState(false);
  const [isBankCollapsed, setIsBankCollapsed] = useState(false);
  const [isAssetCollapsed, setIsAssetCollapsed] = useState(false);
  const [isEmployeeCollapsed, setIsEmployeeCollapsed] = useState(false);
  const [isExpenseCollapsed, setIsExpenseCollapsed] = useState(false);
  const [isDebtorCollapsed, setIsDebtorCollapsed] = useState(false);
  const [isItemCollapsed, setIsItemCollapsed] = useState(false);

  const [accounts, setAccounts] = useState([]);
  const [selectedAccountNum, setSelectedAccountNum] = useState(defaultFilters.account || '');
  const [useAccountFilter, setUseAccountFilter] = useState(!!defaultFilters.account);
  const [searchText, setSearchText] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  const [startDate, setStartDate] = useState(defaultFilters.startDate || (() => {
    const y = new Date().getFullYear();
    return `${y}-01-01`;
  })());
  const [endDate, setEndDate] = useState(defaultFilters.endDate || (() => {
    return new Date().toISOString().split('T')[0];
  })());

  const [selectedCurrency, setSelectedCurrency] = useState(defaultFilters.currency || '');

  // Customer searchable dropdown states
  const [customers, setCustomers] = useState([]);
  const [selectedFromCust, setSelectedFromCust] = useState(defaultFilters.fromCustomer || '');
  const [fromCustSearch, setFromCustSearch] = useState('');
  const [isFromCustOpen, setIsFromCustOpen] = useState(false);
  const fromCustRef = useRef(null);

  const [selectedToCust, setSelectedToCust] = useState(defaultFilters.toCustomer || '');
  const [toCustSearch, setToCustSearch] = useState('');
  const [isToCustOpen, setIsToCustOpen] = useState(false);
  const toCustRef = useRef(null);

  // Vendor searchable dropdown states
  const [vendors, setVendors] = useState([]);
  const [selectedFromVendor, setSelectedFromVendor] = useState(defaultFilters.fromVendor || '');
  const [fromVendorSearch, setFromVendorSearch] = useState('');
  const [isFromVendorOpen, setIsFromVendorOpen] = useState(false);
  const fromVendorRef = useRef(null);

  const [selectedToVendor, setSelectedToVendor] = useState(defaultFilters.toVendor || '');
  const [toVendorSearch, setToVendorSearch] = useState('');
  const [isToVendorOpen, setIsToVendorOpen] = useState(false);
  const toVendorRef = useRef(null);

  // Bank searchable dropdown states
  const [banks, setBanks] = useState([]);
  const [selectedFromBank, setSelectedFromBank] = useState(defaultFilters.fromBank || '');
  const [fromBankSearch, setFromBankSearch] = useState('');
  const [isFromBankOpen, setIsFromBankOpen] = useState(false);
  const fromBankRef = useRef(null);

  const [selectedToBank, setSelectedToBank] = useState(defaultFilters.toBank || '');
  const [toBankSearch, setToBankSearch] = useState('');
  const [isToBankOpen, setIsToBankOpen] = useState(false);
  const toBankRef = useRef(null);

  // Asset searchable dropdown states
  const [assets, setAssets] = useState([]);
  const [selectedFromAsset, setSelectedFromAsset] = useState(defaultFilters.fromAsset || '');
  const [fromAssetSearch, setFromAssetSearch] = useState('');
  const [isFromAssetOpen, setIsFromAssetOpen] = useState(false);
  const fromAssetRef = useRef(null);

  const [selectedToAsset, setSelectedToAsset] = useState(defaultFilters.toAsset || '');
  const [toAssetSearch, setToAssetSearch] = useState('');
  const [isToAssetOpen, setIsToAssetOpen] = useState(false);
  const toAssetRef = useRef(null);

  // Employee searchable dropdown states
  const [employees, setEmployees] = useState([]);
  const [selectedFromEmployee, setSelectedFromEmployee] = useState(defaultFilters.fromEmployee || '');
  const [fromEmployeeSearch, setFromEmployeeSearch] = useState('');
  const [isFromEmployeeOpen, setIsFromEmployeeOpen] = useState(false);
  const fromEmployeeRef = useRef(null);

  const [selectedToEmployee, setSelectedToEmployee] = useState(defaultFilters.toEmployee || '');
  const [toEmployeeSearch, setToEmployeeSearch] = useState('');
  const [isToEmployeeOpen, setIsToEmployeeOpen] = useState(false);
  const toEmployeeRef = useRef(null);

  // Expense searchable dropdown states
  const [expenses, setExpenses] = useState([]);
  const [selectedFromExpense, setSelectedFromExpense] = useState(defaultFilters.fromExpense || '');
  const [fromExpenseSearch, setFromExpenseSearch] = useState('');
  const [isFromExpenseOpen, setIsFromExpenseOpen] = useState(false);
  const fromExpenseRef = useRef(null);

  const [selectedToExpense, setSelectedToExpense] = useState(defaultFilters.toExpense || '');
  const [toExpenseSearch, setToExpenseSearch] = useState('');
  const [isToExpenseOpen, setIsToExpenseOpen] = useState(false);
  const toExpenseRef = useRef(null);

  // Debtor searchable dropdown states
  const [debtors, setDebtors] = useState([]);
  const [selectedFromDebtor, setSelectedFromDebtor] = useState(defaultFilters.fromDebtor || '');
  const [fromDebtorSearch, setFromDebtorSearch] = useState('');
  const [isFromDebtorOpen, setIsFromDebtorOpen] = useState(false);
  const fromDebtorRef = useRef(null);

  const [selectedToDebtor, setSelectedToDebtor] = useState(defaultFilters.toDebtor || '');
  const [toDebtorSearch, setToDebtorSearch] = useState('');
  const [isToDebtorOpen, setIsToDebtorOpen] = useState(false);
  const toDebtorRef = useRef(null);

  // Item searchable dropdown states
  const [items, setItems] = useState([]);
  const [selectedFromItem, setSelectedFromItem] = useState(defaultFilters.fromItem || '');
  const [fromItemSearch, setFromItemSearch] = useState('');
  const [isFromItemOpen, setIsFromItemOpen] = useState(false);
  const fromItemRef = useRef(null);

  const [selectedToItem, setSelectedToItem] = useState(defaultFilters.toItem || '');
  const [toItemSearch, setToItemSearch] = useState('');
  const [isToItemOpen, setIsToItemOpen] = useState(false);
  const toItemRef = useRef(null);


  const sidebarRef = useRef(null);

  // Close searchable dropdown lists when clicking outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
        const sel = Array.isArray(accounts) ? accounts.find(a => a && a.AccountNumber === selectedAccountNum) : null;
        if (sel) {
          setSearchText(`${sel.AccountNumber} - ${sel.AccountDescription}`);
        } else {
          setSearchText('');
        }
      }
      if (fromCustRef.current && !fromCustRef.current.contains(event.target)) {
        setIsFromCustOpen(false);
        const selCust = Array.isArray(customers) ? customers.find(c => c && String(c.CustomerNo) === String(selectedFromCust)) : null;
        if (selCust) {
          setFromCustSearch(`${selCust.CustomerNo} - ${selCust.CustomerName}`);
        } else {
          setFromCustSearch('');
        }
      }
      if (toCustRef.current && !toCustRef.current.contains(event.target)) {
        setIsToCustOpen(false);
        const selCust = Array.isArray(customers) ? customers.find(c => c && String(c.CustomerNo) === String(selectedToCust)) : null;
        if (selCust) {
          setToCustSearch(`${selCust.CustomerNo} - ${selCust.CustomerName}`);
        } else {
          setToCustSearch('');
        }
      }
      if (fromVendorRef.current && !fromVendorRef.current.contains(event.target)) {
        setIsFromVendorOpen(false);
        const selVendor = Array.isArray(vendors) ? vendors.find(v => v && String(v.VendorNumber) === String(selectedFromVendor)) : null;
        if (selVendor) {
          setFromVendorSearch(`${selVendor.VendorNumber} - ${selVendor.VendorName}`);
        } else {
          setFromVendorSearch('');
        }
      }
      if (toVendorRef.current && !toVendorRef.current.contains(event.target)) {
        setIsToVendorOpen(false);
        const selVendor = Array.isArray(vendors) ? vendors.find(v => v && String(v.VendorNumber) === String(selectedToVendor)) : null;
        if (selVendor) {
          setToVendorSearch(`${selVendor.VendorNumber} - ${selVendor.VendorName}`);
        } else {
          setToVendorSearch('');
        }
      }
      if (fromBankRef.current && !fromBankRef.current.contains(event.target)) {
        setIsFromBankOpen(false);
        const selBank = Array.isArray(banks) ? banks.find(b => b && String(b.BankAccountNumber) === String(selectedFromBank)) : null;
        if (selBank) {
          setFromBankSearch(`${selBank.BankAccountNumber} - ${selBank.BankAccountName}`);
        } else {
          setFromBankSearch('');
        }
      }
      if (toBankRef.current && !toBankRef.current.contains(event.target)) {
        setIsToBankOpen(false);
        const selBank = Array.isArray(banks) ? banks.find(b => b && String(b.BankAccountNumber) === String(selectedToBank)) : null;
        if (selBank) {
          setToBankSearch(`${selBank.BankAccountNumber} - ${selBank.BankAccountName}`);
        } else {
          setToBankSearch('');
        }
      }
      if (fromAssetRef.current && !fromAssetRef.current.contains(event.target)) {
        setIsFromAssetOpen(false);
        const sel = Array.isArray(assets) ? assets.find(a => a && String(a.AssetID) === String(selectedFromAsset)) : null;
        if (sel) {
          setFromAssetSearch(`${sel.AssetID} - ${sel.AssetName}`);
        } else {
          setFromAssetSearch('');
        }
      }
      if (toAssetRef.current && !toAssetRef.current.contains(event.target)) {
        setIsToAssetOpen(false);
        const sel = Array.isArray(assets) ? assets.find(a => a && String(a.AssetID) === String(selectedToAsset)) : null;
        if (sel) {
          setToAssetSearch(`${sel.AssetID} - ${sel.AssetName}`);
        } else {
          setToAssetSearch('');
        }
      }
      if (fromEmployeeRef.current && !fromEmployeeRef.current.contains(event.target)) {
        setIsFromEmployeeOpen(false);
        const sel = Array.isArray(employees) ? employees.find(e => e && String(e.EmployeeID) === String(selectedFromEmployee)) : null;
        if (sel) {
          setFromEmployeeSearch(`${sel.EmployeeID} - ${sel.EmployeeName}`);
        } else {
          setFromEmployeeSearch('');
        }
      }
      if (toEmployeeRef.current && !toEmployeeRef.current.contains(event.target)) {
        setIsToEmployeeOpen(false);
        const sel = Array.isArray(employees) ? employees.find(e => e && String(e.EmployeeID) === String(selectedToEmployee)) : null;
        if (sel) {
          setToEmployeeSearch(`${sel.EmployeeID} - ${sel.EmployeeName}`);
        } else {
          setToEmployeeSearch('');
        }
      }
      if (fromExpenseRef.current && !fromExpenseRef.current.contains(event.target)) {
        setIsFromExpenseOpen(false);
        const sel = Array.isArray(expenses) ? expenses.find(e => e && String(e.ExpenseID) === String(selectedFromExpense)) : null;
        if (sel) {
          setFromExpenseSearch(`${sel.ExpenseID} - ${sel.ExpenseName}`);
        } else {
          setFromExpenseSearch('');
        }
      }
      if (toExpenseRef.current && !toExpenseRef.current.contains(event.target)) {
        setIsToExpenseOpen(false);
        const sel = Array.isArray(expenses) ? expenses.find(e => e && String(e.ExpenseID) === String(selectedToExpense)) : null;
        if (sel) {
          setToExpenseSearch(`${sel.ExpenseID} - ${sel.ExpenseName}`);
        } else {
          setToExpenseSearch('');
        }
      }
      if (fromDebtorRef.current && !fromDebtorRef.current.contains(event.target)) {
        setIsFromDebtorOpen(false);
        const sel = Array.isArray(debtors) ? debtors.find(d => d && String(d.DRNumber) === String(selectedFromDebtor)) : null;
        if (sel) {
          setFromDebtorSearch(`${sel.DRNumber} - ${sel.DRName}`);
        } else {
          setFromDebtorSearch('');
        }
      }
      if (toDebtorRef.current && !toDebtorRef.current.contains(event.target)) {
        setIsToDebtorOpen(false);
        const sel = Array.isArray(debtors) ? debtors.find(d => d && String(d.DRNumber) === String(selectedToDebtor)) : null;
        if (sel) {
          setToDebtorSearch(`${sel.DRNumber} - ${sel.DRName}`);
        } else {
          setToDebtorSearch('');
        }
      }
      if (fromItemRef.current && !fromItemRef.current.contains(event.target)) {
        setIsFromItemOpen(false);
        const sel = Array.isArray(items) ? items.find(i => i && String(i.ItemCode || i.ItemID) === String(selectedFromItem)) : null;
        if (sel) {
          setFromItemSearch(`${sel.ItemCode || sel.ItemID} - ${sel.ItemDescription || sel.ItemName}`);
        } else {
          setFromItemSearch('');
        }
      }
      if (toItemRef.current && !toItemRef.current.contains(event.target)) {
        setIsToItemOpen(false);
        const sel = Array.isArray(items) ? items.find(i => i && String(i.ItemCode || i.ItemID) === String(selectedToItem)) : null;
        if (sel) {
          setToItemSearch(`${sel.ItemCode || sel.ItemID} - ${sel.ItemDescription || sel.ItemName}`);
        } else {
          setToItemSearch('');
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [
    accounts, selectedAccountNum, 
    customers, selectedFromCust, selectedToCust, 
    vendors, selectedFromVendor, selectedToVendor, 
    banks, selectedFromBank, selectedToBank,
    assets, selectedFromAsset, selectedToAsset,
    employees, selectedFromEmployee, selectedToEmployee,
    expenses, selectedFromExpense, selectedToExpense,
    debtors, selectedFromDebtor, selectedToDebtor,
    items, selectedFromItem, selectedToItem
  ]);

  const selectedAccount = useMemo(() => {
    return Array.isArray(accounts) ? accounts.find(a => a && a.AccountNumber === selectedAccountNum) || null : null;
  }, [accounts, selectedAccountNum]);

  const filterCustomerList = (txt, selectedCode) => {
    if (!Array.isArray(customers)) return [];
    if (!txt) return customers;
    const selectedObj = customers.find(c => c && String(c.CustomerNo) === String(selectedCode));
    if (selectedObj && txt === `${selectedObj.CustomerNo} - ${selectedObj.CustomerName}`) return customers;
    const term = txt.toLowerCase();
    return customers.filter(cust => cust && (String(cust.CustomerNo || '').toLowerCase().includes(term) || String(cust.CustomerName || '').toLowerCase().includes(term)));
  };

  const filterVendorList = (txt, selectedCode) => {
    if (!Array.isArray(vendors)) return [];
    if (!txt) return vendors;
    const selectedObj = vendors.find(v => v && String(v.VendorNumber) === String(selectedCode));
    if (selectedObj && txt === `${selectedObj.VendorNumber} - ${selectedObj.VendorName}`) return vendors;
    const term = txt.toLowerCase();
    return vendors.filter(v => v && (String(v.VendorNumber || '').toLowerCase().includes(term) || String(v.VendorName || '').toLowerCase().includes(term)));
  };

  const filterBankList = (txt, selectedCode) => {
    if (!Array.isArray(banks)) return [];
    if (!txt) return banks;
    const selectedObj = banks.find(b => b && String(b.BankAccountNumber) === String(selectedCode));
    if (selectedObj && txt === `${selectedObj.BankAccountNumber} - ${selectedObj.BankAccountName}`) return banks;
    const term = txt.toLowerCase();
    return banks.filter(b => b && (String(b.BankAccountNumber || '').toLowerCase().includes(term) || String(b.BankAccountName || '').toLowerCase().includes(term)));
  };

  const filterAssetList = (txt, selectedCode) => {
    if (!Array.isArray(assets)) return [];
    if (!txt) return assets;
    const selectedObj = assets.find(a => a && String(a.AssetID) === String(selectedCode));
    if (selectedObj && txt === `${selectedObj.AssetID} - ${selectedObj.AssetName}`) return assets;
    const term = txt.toLowerCase();
    return assets.filter(a => a && (String(a.AssetID || '').toLowerCase().includes(term) || String(a.AssetName || '').toLowerCase().includes(term)));
  };

  const filterEmployeeList = (txt, selectedCode) => {
    if (!Array.isArray(employees)) return [];
    if (!txt) return employees;
    const selectedObj = employees.find(e => e && String(e.EmployeeID) === String(selectedCode));
    if (selectedObj && txt === `${selectedObj.EmployeeID} - ${selectedObj.EmployeeName}`) return employees;
    const term = txt.toLowerCase();
    return employees.filter(e => e && (String(e.EmployeeID || '').toLowerCase().includes(term) || String(e.EmployeeName || '').toLowerCase().includes(term)));
  };

  const filterExpenseList = (txt, selectedCode) => {
    if (!Array.isArray(expenses)) return [];
    if (!txt) return expenses;
    const selectedObj = expenses.find(e => e && String(e.ExpenseID) === String(selectedCode));
    if (selectedObj && txt === `${selectedObj.ExpenseID} - ${selectedObj.ExpenseName}`) return expenses;
    const term = txt.toLowerCase();
    return expenses.filter(e => e && (String(e.ExpenseID || '').toLowerCase().includes(term) || String(e.ExpenseName || '').toLowerCase().includes(term)));
  };

  const getFilteredOptions = (list, txt, fields) => {
    if (!Array.isArray(list)) return [];
    if (!txt) return list;
    const term = txt.toLowerCase();
    return list.filter(item => fields.some(field => String(item[field] || '').toLowerCase().includes(term)));
  };

  const filteredFromCustomers = useMemo(() => filterCustomerList(fromCustSearch, selectedFromCust), [customers, fromCustSearch, selectedFromCust]);
  const filteredToCustomers = useMemo(() => filterCustomerList(toCustSearch, selectedToCust), [customers, toCustSearch, selectedToCust]);
  const filteredFromVendors = useMemo(() => filterVendorList(fromVendorSearch, selectedFromVendor), [vendors, fromVendorSearch, selectedFromVendor]);
  const filteredToVendors = useMemo(() => filterVendorList(toVendorSearch, selectedToVendor), [vendors, toVendorSearch, selectedToVendor]);
  const filteredFromBanks = useMemo(() => filterBankList(fromBankSearch, selectedFromBank), [banks, fromBankSearch, selectedFromBank]);
  const filteredToBanks = useMemo(() => filterBankList(toBankSearch, selectedToBank), [banks, toBankSearch, selectedToBank]);
  const filteredFromAssets = useMemo(() => filterAssetList(fromAssetSearch, selectedFromAsset), [assets, fromAssetSearch, selectedFromAsset]);
  const filteredToAssets = useMemo(() => filterAssetList(toAssetSearch, selectedToAsset), [assets, toAssetSearch, selectedToAsset]);
  const filteredFromEmployees = useMemo(() => filterEmployeeList(fromEmployeeSearch, selectedFromEmployee), [employees, fromEmployeeSearch, selectedFromEmployee]);
  const filteredToEmployees = useMemo(() => filterEmployeeList(toEmployeeSearch, selectedToEmployee), [employees, toEmployeeSearch, selectedToEmployee]);
  const filteredFromExpenses = useMemo(() => filterExpenseList(fromExpenseSearch, selectedFromExpense), [expenses, fromExpenseSearch, selectedFromExpense]);
  const filteredToExpenses = useMemo(() => filterExpenseList(toExpenseSearch, selectedToExpense), [expenses, toExpenseSearch, selectedToExpense]);

  const filteredFromDebtors = useMemo(() => getFilteredOptions(debtors, fromDebtorSearch, ['DRNumber', 'DRName']), [debtors, fromDebtorSearch]);
  const filteredToDebtors = useMemo(() => getFilteredOptions(debtors, toDebtorSearch, ['DRNumber', 'DRName']), [debtors, toDebtorSearch]);
  const filteredFromItems = useMemo(() => getFilteredOptions(items, fromItemSearch, ['ItemCode', 'ItemID', 'ItemDescription', 'ItemName']), [items, fromItemSearch]);
  const filteredToItems = useMemo(() => getFilteredOptions(items, toItemSearch, ['ItemCode', 'ItemID', 'ItemDescription', 'ItemName']), [items, toItemSearch]);


  const filteredAccounts = useMemo(() => {
    if (!Array.isArray(accounts)) return [];
    if (!searchText) return accounts;
    if (selectedAccount && searchText === `${selectedAccount.AccountNumber} - ${selectedAccount.AccountDescription}`) {
      return accounts;
    }
    const term = searchText.toLowerCase();
    return accounts.filter(acc => 
      (acc.AccountNumber || '').toLowerCase().includes(term) ||
      (acc.AccountDescription || '').toLowerCase().includes(term) ||
      (acc.AccountType || '').toLowerCase().includes(term)
    );
  }, [accounts, searchText, selectedAccount]);

  useEffect(() => {
    if (hasAccount) apiCall('Accounts Master All', null, { User: user?.Username }, 'lookup').then(d => { if (d.State === 0) setAccounts(d.List0 || []); });
    if (hasCustomer) apiCall('Customer Master All', null, { User: user?.Username }, 'lookup').then(d => { if (d.State === 0) setCustomers(d.List0 || []); });
    if (hasVendor) apiCall('Vendor Master All', null, { User: user?.Username }, 'lookup').then(d => { if (d.State === 0) setVendors(d.List0 || []); });
    if (hasBank) apiCall('Bank Accounts Master', null, { User: user?.Username }, 'lookup').then(d => { if (d.State === 0) setBanks(d.List0 || []); });
    if (hasAsset) apiCall('Asset Master All', null, { User: user?.Username }, 'lookup').then(d => { if (d.State === 0) setAssets(d.List0 || []); });
    if (hasEmployee) apiCall('Employee Master All', null, { User: user?.Username }, 'lookup').then(d => { if (d.State === 0) setEmployees(d.List0 || []); });
    if (hasExpense) apiCall('Expense Master All', null, { User: user?.Username }, 'lookup').then(d => { if (d.State === 0) setExpenses(d.List0 || []); });
    if (hasDebtor) apiCall('DebtorCreditor Master All', null, { User: user?.Username }, 'lookup').then(d => { if (d.State === 0) setDebtors(d.List0 || []); });
    if (hasItem) apiCall('Item Master All', null, { User: user?.Username }, 'lookup').then(d => { if (d.State === 0) setItems(d.List0 || []); });
  }, [user, hasAccount, hasCustomer, hasVendor, hasBank, hasAsset, hasEmployee, hasExpense, hasDebtor, hasItem]);

  // When only "From" is picked and "To" is left blank, treat it as an exact
  // match on "From" rather than an open-ended range.
  const rangeTo = (from, to) => (from && !to ? from : to);

  const handleGenerate = () => {
    if (onSearch) {
      onSearch({
        account: useAccountFilter ? (selectedAccountNum || (searchText ? searchText.split(' - ')[0].trim() : '')) : '',
        startDate,
        endDate,
        currency: selectedCurrency,
        fromCustomer: selectedFromCust,
        toCustomer: rangeTo(selectedFromCust, selectedToCust),
        fromVendor: selectedFromVendor,
        toVendor: rangeTo(selectedFromVendor, selectedToVendor),
        fromBank: selectedFromBank,
        toBank: rangeTo(selectedFromBank, selectedToBank),
        fromAsset: selectedFromAsset,
        toAsset: rangeTo(selectedFromAsset, selectedToAsset),
        fromEmployee: selectedFromEmployee,
        toEmployee: rangeTo(selectedFromEmployee, selectedToEmployee),
        fromExpense: selectedFromExpense,
        toExpense: rangeTo(selectedFromExpense, selectedToExpense),
        fromDebtor: selectedFromDebtor,
        toDebtor: rangeTo(selectedFromDebtor, selectedToDebtor),
        fromItem: selectedFromItem,
        toItem: rangeTo(selectedFromItem, selectedToItem)
      });
    }
  };

  return (
    <>
      {/* Left Sidebar Filters Panel */}
      {isSidebarCollapsed ? (
        <div style={{
          width: '44px',
          minWidth: '44px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '16px',
          boxShadow: 'var(--shadow)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '16px 0',
          gap: 20,
          zIndex: 10
        }}>
          <button
            onClick={() => setIsSidebarCollapsed(false)}
            title="Expand Filters"
            style={{
              background: 'var(--soft)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              width: '28px',
              height: '28px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '12px',
              color: 'var(--orange2)'
            }}
          >
            ▶
          </button>
          <div style={{
            transform: 'rotate(-90deg)',
            textTransform: 'uppercase',
            fontSize: '11px',
            fontWeight: '800',
            color: 'var(--muted)',
            letterSpacing: '2px',
            userSelect: 'none',
            marginTop: '32px',
            whiteSpace: 'nowrap'
          }}>
            Filter Panel
          </div>
        </div>
      ) : (
        <div style={{ width: '280px', minWidth: '280px', position: 'relative' }}>
          <div ref={sidebarRef} style={{
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: '280px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: '16px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            zIndex: 20
          }}>
          {/* Header with Collapse Toggle */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '10px', flexShrink: 0 }}>
            <span style={{ fontSize: '12px', fontWeight: '800', color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Filters</span>
            <button
              onClick={() => setIsSidebarCollapsed(true)}
              title="Collapse Filters"
              style={{
                background: 'var(--soft)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '4px 8px',
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: '700',
                color: 'var(--muted)',
                display: 'flex',
                alignItems: 'center',
                gap: 4
              }}
            >
              ◀ Hide
            </button>
          </div>
          
          {/* Main Filters Vertical Layout */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: '4px' }}>
            
            {hasAccount && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderBottom: '1px solid var(--border)', paddingBottom: '14px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px', fontWeight: '700', color: 'var(--text)', cursor: 'pointer' }}>
                    <input 
                      type="checkbox" 
                      checked={useAccountFilter}
                      onChange={(e) => {
                        setUseAccountFilter(e.target.checked);
                        if (!e.target.checked) {
                          setSelectedAccountNum('');
                          setSearchText('');
                        }
                      }}
                      style={{ width: '16px', height: '16px', accentColor: 'var(--orange)' }}
                    />
                    Use Account Filter
                  </label>
                </div>

                {useAccountFilter && (
                  <div 
                    ref={dropdownRef} 
                    style={{ 
                      display: 'flex', 
                      flexDirection: 'column', 
                      gap: 6,
                      position: 'relative' 
                    }}
                  >
                  <label style={{ fontSize: '12px', fontWeight: '800', color: 'var(--muted)', textTransform: 'uppercase' }}>Select Account</label>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <input
                      type="text"
                      value={searchText}
                      onChange={(e) => {
                        setSearchText(e.target.value);
                        setIsOpen(true);
                        if (!e.target.value) {
                          setSelectedAccountNum('');
                        }
                      }}
                      onFocus={() => {
                        setIsOpen(true);
                        setSearchText('');
                      }}
                      placeholder="🔍 Search account..."
                      style={{
                        width: '100%',
                        height: '38px',
                        padding: '0 32px 0 12px',
                        border: '1px solid var(--border)',
                        borderRadius: '10px',
                        fontSize: '13px',
                        background: 'var(--soft)',
                        color: 'var(--text)',
                        outline: 'none',
                        fontFamily: 'var(--font)'
                      }}
                    />
                    {searchText && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSearchText('');
                          setSelectedAccountNum('');
                          setIsOpen(true);
                        }}
                        style={{
                          position: 'absolute',
                          right: '32px',
                          border: 'none',
                          background: 'none',
                          cursor: 'pointer',
                          fontSize: '12px',
                          color: 'var(--hint)'
                        }}
                      >
                        ✕
                      </button>
                    )}
                    <span
                      onClick={() => setIsOpen(prev => !prev)}
                      style={{
                        position: 'absolute',
                        right: '12px',
                        cursor: 'pointer',
                        fontSize: '10px',
                        color: 'var(--muted)',
                        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.15s ease'
                      }}
                    >
                      ▼
                    </span>
                  </div>

                  {isOpen && (
                    <div style={{
                      position: 'absolute',
                      top: '100%',
                      left: 0,
                      right: 0,
                      zIndex: 9999,
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: '10px',
                      boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
                      marginTop: '4px',
                      maxHeight: '220px',
                      overflowY: 'auto',
                      padding: '6px'
                    }}>
                      {filteredAccounts.length === 0 ? (
                        <div style={{ padding: '8px 12px', fontSize: '12.5px', color: 'var(--muted)' }}>
                          No accounts match search terms
                        </div>
                      ) : (
                        filteredAccounts.map(acc => {
                          const isCurrent = acc.AccountNumber === selectedAccountNum;
                          return (
                            <div
                              key={acc.AccountNumber}
                              onClick={() => {
                                setSelectedAccountNum(acc.AccountNumber);
                                setSearchText(`${acc.AccountNumber} - ${acc.AccountDescription}`);
                                setIsOpen(false);
                              }}
                              style={{
                                padding: '8px 12px',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                background: isCurrent ? 'var(--orange-glow)' : 'transparent',
                                color: isCurrent ? 'var(--orange2)' : 'var(--text)',
                                fontSize: '12.5px',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                transition: 'background 0.1s ease',
                                marginBottom: '2px'
                              }}
                              onMouseEnter={(e) => {
                                if (!isCurrent) e.currentTarget.style.background = 'var(--soft)';
                              }}
                              onMouseLeave={(e) => {
                                if (!isCurrent) e.currentTarget.style.background = 'transparent';
                              }}
                            >
                              <span style={{ fontWeight: isCurrent ? 700 : 500 }}>
                                {acc.AccountNumber} - {acc.AccountDescription}
                              </span>
                              <span style={{
                                fontSize: '10px',
                                fontWeight: 800,
                                color: 'var(--muted)',
                                background: 'var(--soft)',
                                padding: '2px 6px',
                                borderRadius: '4px'
                              }}>
                                {acc.AccountType}
                              </span>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
                )}
              </div>
            )}

            {/* Generate Button (kept sticky at the top-ish or after main account selection) */}
            <button 
              className="btn-primary" 
              onClick={handleGenerate} 
              disabled={loading}
              style={{ height: '38px', width: '100%', fontWeight: '700', borderRadius: '10px', whiteSpace: 'nowrap', fontSize: '13px' }}
            >
              {loading ? 'Fetching…' : '🔍 Generate'}
            </button>

            {hasDate && (
              <div style={{ 
                background: 'var(--soft)', 
                borderRadius: '12px', 
                padding: '12px', 
                border: '1px solid var(--border)',
                display: 'flex', 
                flexDirection: 'column', 
                gap: isDateCollapsed ? 0 : 10 
              }}>
                <div 
                  onClick={() => setIsDateCollapsed(prev => !prev)}
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'space-between', 
                    fontSize: '11px', 
                    fontWeight: '800', 
                    color: 'var(--orange-dark)', 
                    textTransform: 'uppercase', 
                    borderBottom: isDateCollapsed ? 'none' : '1px solid var(--border)', 
                    paddingBottom: isDateCollapsed ? '0' : '6px',
                    cursor: 'pointer',
                    userSelect: 'none'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>📅</span> Date
                  </div>
                  <span style={{ fontSize: '9px', color: 'var(--muted)' }}>{isDateCollapsed ? '▼' : '▲'}</span>
                </div>
                {!isDateCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label style={{ fontSize: '11.5px', fontWeight: '700', color: 'var(--muted)', textTransform: 'uppercase' }}>Start Date</label>
                      <input
                        type="date"
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                        style={{
                          height: '38px',
                          padding: '0 12px',
                          border: '1px solid var(--border)',
                          borderRadius: '10px',
                          fontSize: '13px',
                          background: 'var(--surface)',
                          color: 'var(--text)',
                          outline: 'none',
                          fontFamily: 'var(--font)'
                        }}
                      />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <label style={{ fontSize: '11.5px', fontWeight: '700', color: 'var(--muted)', textTransform: 'uppercase' }}>End Date</label>
                      <input
                        type="date"
                        value={endDate}
                        onChange={(e) => setEndDate(e.target.value)}
                        style={{
                          height: '38px',
                          padding: '0 12px',
                          border: '1px solid var(--border)',
                          borderRadius: '10px',
                          fontSize: '13px',
                          background: 'var(--surface)',
                          color: 'var(--text)',
                          outline: 'none',
                          fontFamily: 'var(--font)'
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {hasCurrency && (
              <div style={{ 
                background: 'var(--soft)', 
                borderRadius: '12px', 
                padding: '12px', 
                border: '1px solid var(--border)',
                display: 'flex', 
                flexDirection: 'column', 
                gap: isCurrencyCollapsed ? 0 : 10 
              }}>
                <div 
                  onClick={() => setIsCurrencyCollapsed(prev => !prev)}
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'space-between', 
                    fontSize: '11px', 
                    fontWeight: '800', 
                    color: 'var(--orange-dark)', 
                    textTransform: 'uppercase', 
                    borderBottom: isCurrencyCollapsed ? 'none' : '1px solid var(--border)', 
                    paddingBottom: isCurrencyCollapsed ? '0' : '6px',
                    cursor: 'pointer',
                    userSelect: 'none'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>💵</span> Currency
                  </div>
                  <span style={{ fontSize: '9px', color: 'var(--muted)' }}>{isCurrencyCollapsed ? '▼' : '▲'}</span>
                </div>
                {!isCurrencyCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <select
                      value={selectedCurrency}
                      onChange={(e) => setSelectedCurrency(e.target.value)}
                      style={{
                        height: '38px',
                        padding: '0 12px',
                        border: '1px solid var(--border)',
                        borderRadius: '10px',
                        fontSize: '13px',
                        background: 'var(--surface)',
                        color: 'var(--text)',
                        outline: 'none',
                        fontFamily: 'var(--font)',
                        cursor: 'pointer'
                      }}
                    >
                      <option value="">All Currencies</option>
                      <option value="EGP">EGP</option>
                      <option value="USD">USD</option>
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* A reusable helper for rendering generic from/to filters to avoid huge code duplication */}
            {(() => {
              const renderRangeFilter = (
                title, 
                icon, 
                isCollapsed, 
                setIsCollapsed, 
                refFrom, 
                refTo,
                searchFrom, 
                setSearchFrom, 
                selectedFrom, 
                setSelectedFrom, 
                isOpenFrom, 
                setIsOpenFrom, 
                filteredFromList, 
                searchTo, 
                setSearchTo, 
                selectedTo, 
                setSelectedTo, 
                isOpenTo, 
                setIsOpenTo, 
                filteredToList,
                idKey,
                nameKey
              ) => (
                <div style={{ 
                  background: 'var(--soft)', 
                  borderRadius: '12px', 
                  padding: '12px', 
                  border: '1px solid var(--border)',
                  display: 'flex', 
                  flexDirection: 'column', 
                  gap: isCollapsed ? 0 : 10 
                }}>
                  <div 
                    onClick={() => setIsCollapsed(prev => !prev)}
                    style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      justifyContent: 'space-between', 
                      fontSize: '11px', 
                      fontWeight: '800', 
                      color: 'var(--orange-dark)', 
                      textTransform: 'uppercase', 
                      borderBottom: isCollapsed ? 'none' : '1px solid var(--border)', 
                      paddingBottom: isCollapsed ? '0' : '6px',
                      cursor: 'pointer',
                      userSelect: 'none'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{icon}</span> {title}
                    </div>
                    <span style={{ fontSize: '9px', color: 'var(--muted)' }}>{isCollapsed ? '▼' : '▲'}</span>
                  </div>
                  {!isCollapsed && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {/* From */}
                    <div 
                      ref={refFrom} 
                      style={{ display: 'flex', flexDirection: 'column', gap: 4, position: 'relative' }}
                    >
                      <label style={{ fontSize: '11.5px', fontWeight: '700', color: 'var(--muted)', textTransform: 'uppercase' }}>From {title}</label>
                      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                        <input
                          type="text"
                          value={searchFrom}
                          onChange={(e) => {
                            setSearchFrom(e.target.value);
                            setIsOpenFrom(true);
                            if (!e.target.value) { setSelectedFrom(''); }
                          }}
                          onFocus={() => { setIsOpenFrom(true); setSearchFrom(''); }}
                          placeholder="Search from..."
                          style={{
                            width: '100%', height: '38px', padding: '0 32px 0 12px',
                            border: '1px solid var(--border)', borderRadius: '10px',
                            fontSize: '13px', background: 'var(--surface)', color: 'var(--text)',
                            outline: 'none', fontFamily: 'var(--font)'
                          }}
                        />
                        {searchFrom && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation(); setSearchFrom(''); setSelectedFrom(''); setIsOpenFrom(true);
                            }}
                            style={{ position: 'absolute', right: '32px', border: 'none', background: 'none', cursor: 'pointer', fontSize: '12px', color: 'var(--hint)' }}
                          >✕</button>
                        )}
                        <span
                          onClick={() => setIsOpenFrom(prev => !prev)}
                          style={{
                            position: 'absolute', right: '12px', cursor: 'pointer', fontSize: '10px', color: 'var(--muted)',
                            transform: isOpenFrom ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease'
                          }}
                        >▼</span>
                      </div>
      
                      {isOpenFrom && (
                        <div style={{
                          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 9999, background: 'var(--surface)',
                          border: '1px solid var(--border)', borderRadius: '10px', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
                          marginTop: '4px', maxHeight: '220px', overflowY: 'auto', padding: '6px'
                        }}>
                          {filteredFromList.length === 0 ? (
                            <div style={{ padding: '8px 12px', fontSize: '12.5px', color: 'var(--muted)' }}>No matches</div>
                          ) : (
                            filteredFromList.filter(Boolean).map(item => {
                              const isCurrent = String(item[idKey]) === String(selectedFrom);
                              return (
                                <div
                                  key={item[idKey]}
                                  onClick={() => {
                                    setSelectedFrom(item[idKey]);
                                    setSearchFrom(`${item[idKey]} - ${item[nameKey]}`);
                                    setIsOpenFrom(false);
                                  }}
                                  style={{
                                    padding: '8px 12px', borderRadius: '6px', cursor: 'pointer',
                                    background: isCurrent ? 'var(--orange-glow)' : 'transparent', color: isCurrent ? 'var(--orange2)' : 'var(--text)',
                                    fontSize: '12.5px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                    transition: 'background 0.1s ease', marginBottom: '2px'
                                  }}
                                  onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = 'var(--soft)'; }}
                                  onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <span style={{ fontWeight: isCurrent ? 700 : 500 }}>{item[idKey]} - {item[nameKey]}</span>
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
      
                    {/* To */}
                    <div 
                      ref={refTo} 
                      style={{ display: 'flex', flexDirection: 'column', gap: 4, position: 'relative' }}
                    >
                      <label style={{ fontSize: '11.5px', fontWeight: '700', color: 'var(--muted)', textTransform: 'uppercase' }}>To {title}</label>
                      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                        <input
                          type="text"
                          value={searchTo}
                          onChange={(e) => {
                            setSearchTo(e.target.value);
                            setIsOpenTo(true);
                            if (!e.target.value) { setSelectedTo(''); }
                          }}
                          onFocus={() => { setIsOpenTo(true); setSearchTo(''); }}
                          placeholder="Search to..."
                          style={{
                            width: '100%', height: '38px', padding: '0 32px 0 12px',
                            border: '1px solid var(--border)', borderRadius: '10px',
                            fontSize: '13px', background: 'var(--surface)', color: 'var(--text)',
                            outline: 'none', fontFamily: 'var(--font)'
                          }}
                        />
                        {searchTo && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation(); setSearchTo(''); setSelectedTo(''); setIsOpenTo(true);
                            }}
                            style={{ position: 'absolute', right: '32px', border: 'none', background: 'none', cursor: 'pointer', fontSize: '12px', color: 'var(--hint)' }}
                          >✕</button>
                        )}
                        <span
                          onClick={() => setIsOpenTo(prev => !prev)}
                          style={{
                            position: 'absolute', right: '12px', cursor: 'pointer', fontSize: '10px', color: 'var(--muted)',
                            transform: isOpenTo ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s ease'
                          }}
                        >▼</span>
                      </div>
      
                      {isOpenTo && (
                        <div style={{
                          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 9999, background: 'var(--surface)',
                          border: '1px solid var(--border)', borderRadius: '10px', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
                          marginTop: '4px', maxHeight: '220px', overflowY: 'auto', padding: '6px'
                        }}>
                          {filteredToList.length === 0 ? (
                            <div style={{ padding: '8px 12px', fontSize: '12.5px', color: 'var(--muted)' }}>No matches</div>
                          ) : (
                            filteredToList.filter(Boolean).map(item => {
                              const isCurrent = String(item[idKey]) === String(selectedTo);
                              return (
                                <div
                                  key={item[idKey]}
                                  onClick={() => {
                                    setSelectedTo(item[idKey]);
                                    setSearchTo(`${item[idKey]} - ${item[nameKey]}`);
                                    setIsOpenTo(false);
                                  }}
                                  style={{
                                    padding: '8px 12px', borderRadius: '6px', cursor: 'pointer',
                                    background: isCurrent ? 'var(--orange-glow)' : 'transparent', color: isCurrent ? 'var(--orange2)' : 'var(--text)',
                                    fontSize: '12.5px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                    transition: 'background 0.1s ease', marginBottom: '2px'
                                  }}
                                  onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = 'var(--soft)'; }}
                                  onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = 'transparent'; }}
                                >
                                  <span style={{ fontWeight: isCurrent ? 700 : 500 }}>{item[idKey]} - {item[nameKey]}</span>
                                </div>
                              );
                            })
                          )}
                        </div>
                      )}
                    </div>
                    </div>
                  )}
                </div>
              );

              return (
                <>
                  {hasCustomer && renderRangeFilter('Customer', '🏢', isCustomerCollapsed, setIsCustomerCollapsed, fromCustRef, toCustRef, fromCustSearch, setFromCustSearch, selectedFromCust, setSelectedFromCust, isFromCustOpen, setIsFromCustOpen, filteredFromCustomers, toCustSearch, setToCustSearch, selectedToCust, setSelectedToCust, isToCustOpen, setIsToCustOpen, filteredToCustomers, 'CustomerNo', 'CustomerName')}
                  {hasVendor && renderRangeFilter('Vendor', '🏭', isVendorCollapsed, setIsVendorCollapsed, fromVendorRef, toVendorRef, fromVendorSearch, setFromVendorSearch, selectedFromVendor, setSelectedFromVendor, isFromVendorOpen, setIsFromVendorOpen, filteredFromVendors, toVendorSearch, setToVendorSearch, selectedToVendor, setSelectedToVendor, isToVendorOpen, setIsToVendorOpen, filteredToVendors, 'VendorNumber', 'VendorName')}
                  {hasBank && renderRangeFilter('Bank', '🏦', isBankCollapsed, setIsBankCollapsed, fromBankRef, toBankRef, fromBankSearch, setFromBankSearch, selectedFromBank, setSelectedFromBank, isFromBankOpen, setIsFromBankOpen, filteredFromBanks, toBankSearch, setToBankSearch, selectedToBank, setSelectedToBank, isToBankOpen, setIsToBankOpen, filteredToBanks, 'BankAccountNumber', 'BankAccountName')}
                  {hasAsset && renderRangeFilter('Asset', '📦', isAssetCollapsed, setIsAssetCollapsed, fromAssetRef, toAssetRef, fromAssetSearch, setFromAssetSearch, selectedFromAsset, setSelectedFromAsset, isFromAssetOpen, setIsFromAssetOpen, filteredFromAssets, toAssetSearch, setToAssetSearch, selectedToAsset, setSelectedToAsset, isToAssetOpen, setIsToAssetOpen, filteredToAssets, 'AssetID', 'AssetName')}
                  {hasEmployee && renderRangeFilter('Employee', '👩‍💼', isEmployeeCollapsed, setIsEmployeeCollapsed, fromEmployeeRef, toEmployeeRef, fromEmployeeSearch, setFromEmployeeSearch, selectedFromEmployee, setSelectedFromEmployee, isFromEmployeeOpen, setIsFromEmployeeOpen, filteredFromEmployees, toEmployeeSearch, setToEmployeeSearch, selectedToEmployee, setSelectedToEmployee, isToEmployeeOpen, setIsToEmployeeOpen, filteredToEmployees, 'EmployeeID', 'EmployeeName')}
                  {hasExpense && renderRangeFilter('Expense', '💸', isExpenseCollapsed, setIsExpenseCollapsed, fromExpenseRef, toExpenseRef, fromExpenseSearch, setFromExpenseSearch, selectedFromExpense, setSelectedFromExpense, isFromExpenseOpen, setIsFromExpenseOpen, filteredFromExpenses, toExpenseSearch, setToExpenseSearch, selectedToExpense, setSelectedToExpense, isToExpenseOpen, setIsToExpenseOpen, filteredToExpenses, 'ExpenseID', 'ExpenseName')}
                  {hasDebtor && renderRangeFilter('Debtor / Creditor', '👥', isDebtorCollapsed, setIsDebtorCollapsed, fromDebtorRef, toDebtorRef, fromDebtorSearch, setFromDebtorSearch, selectedFromDebtor, setSelectedFromDebtor, isFromDebtorOpen, setIsFromDebtorOpen, filteredFromDebtors, toDebtorSearch, setToDebtorSearch, selectedToDebtor, setSelectedToDebtor, isToDebtorOpen, setIsToDebtorOpen, filteredToDebtors, 'DRNumber', 'DRName')}
                  {hasItem && renderRangeFilter('Item', '📦', isItemCollapsed, setIsItemCollapsed, fromItemRef, toItemRef, fromItemSearch, setFromItemSearch, selectedFromItem, setSelectedFromItem, isFromItemOpen, setIsFromItemOpen, filteredFromItems, toItemSearch, setToItemSearch, selectedToItem, setSelectedToItem, isToItemOpen, setIsToItemOpen, filteredToItems, items?.[0]?.ItemCode ? 'ItemCode' : 'ItemID', items?.[0]?.ItemDescription ? 'ItemDescription' : 'ItemName')}
                </>
              );
            })()}

          </div>
          </div>
        </div>
      )}
    </>
  );
}
